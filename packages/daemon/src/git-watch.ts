import { existsSync, type FSWatcher, watch as fsWatch } from "node:fs";
import { open as openFile, readFile, stat as statFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { type SimpleGit, simpleGit } from "simple-git";

/**
 * Per-`cwd` git status watcher with push-based updates.
 *
 * Architecture (mirrors Paseo's `WorkspaceGitService`):
 *
 *   - **fs.watch** on `.git/HEAD` + `.git/refs/heads` for cheap branch-
 *     change / commit-head-move detection. Working-tree changes are NOT
 *     watched (Paseo's recursive scheme is mostly there to cope with
 *     Linux watch limits; we're Mac-only and would only need it for
 *     the `+N -M` diff numbers — see self-heal below).
 *   - **500ms debounce** on watch events absorbs the storm of writes
 *     that hit `.git/index` during a `git add` / staging operation.
 *     This is the only knob that throttles outgoing pushes; everything
 *     below is read-side dedup, not push-side throttling.
 *   - **15s `cachedStatus` TTL** is a read-side optimization: when
 *     multiple subscribers or external callers hit `refresh()` and
 *     nothing has invalidated the cache, return the last snapshot
 *     instead of re-shelling out. Watch events + self-heal both
 *     **invalidate** the cache before re-running git, so this never
 *     delays a real change from being pushed.
 *   - **`inFlight` promise** dedups simultaneous refresh() calls —
 *     if two subscribers arrive in the same tick, only one git
 *     invocation runs and both await the same promise.
 *   - **60s self-heal poll** force-refreshes regardless of watch state
 *     so working-tree edits (which don't touch `.git/`) still surface
 *     within a minute. Also reconciles a watcher that died (rare on
 *     Mac but possible after `rm -rf .git && git init`).
 *   - **p-limit(8)** caps total concurrent git invocations across
 *     every watcher in this daemon — so 10 sessions on 10 different
 *     repos don't fork 10 `git status` processes simultaneously.
 *
 * Lifecycle: watchers start lazily on first `subscribe()` and shut
 * down on the last `unsubscribe()` (or `dispose()`). The cache + the
 * `inFlight` dedup promise persist between watcher cycles.
 */

const GIT_CONCURRENCY = 8;
const STATUS_CACHE_TTL_MS = 15_000;
const DEBOUNCE_MS = 500;
const SELF_HEAL_INTERVAL_MS = 60_000;

/** Caps on untracked-additions counting — Paseo's heuristic. Skip
 *  giant or binary files entirely; a 1 GB log file shouldn't make the
 *  status bar count millions of "additions". */
const UNTRACKED_MAX_FILES = 500;
const UNTRACKED_MAX_FILE_BYTES = 256 * 1024;
const UNTRACKED_BINARY_SNIFF_BYTES = 512;

const gitLimit = pLimit(GIT_CONCURRENCY);

export interface GitStatus {
  /** False when `cwd` isn't a git repository. All other numeric fields
   *  are zero in that case; `project` and `branch` may still be filled. */
  isRepo: boolean;
  /** `path.basename(cwd)`. Matches what the user sees in Finder, works
   *  uniformly across languages (no `package.json` peek), and survives
   *  monorepo sub-package nesting (you see the sub-folder you're in). */
  project: string;
  /** `null` when not a repo OR in detached-HEAD state. Caller can decide
   *  whether to surface a short hash there if they want. */
  branch: string | null;
  /** Local commits ahead/behind upstream. Zero when no upstream is set. */
  ahead: number;
  behind: number;
  /** Lines changed since the comparison ref (typically `origin/<branch>`,
   *  falls back to HEAD with no upstream). Includes unpushed commits +
   *  staged + working-tree edits. **`insertions` also includes every
   *  line of every untracked, non-binary file** so the count matches
   *  what tools like Claude Desktop show (`git diff` alone never sees
   *  untracked files). */
  insertions: number;
  deletions: number;
  /** True when any tracked file is modified OR any untracked file exists. */
  isDirty: boolean;
}

export type GitStatusListener = (status: GitStatus) => void;

const NON_REPO_STATUS = (project: string): GitStatus => ({
  isRepo: false,
  project,
  branch: null,
  ahead: 0,
  behind: 0,
  insertions: 0,
  deletions: 0,
  isDirty: false,
});

export class GitWatcher {
  private readonly cwd: string;
  private readonly project: string;
  private readonly git: SimpleGit;
  private listeners = new Set<GitStatusListener>();
  private cachedStatus: GitStatus | null = null;
  private cacheAt = 0;
  private headWatcher: FSWatcher | null = null;
  private refsWatcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private selfHealTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private inFlight: Promise<GitStatus> | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.project = path.basename(cwd);
    this.git = simpleGit({
      baseDir: cwd,
      // Inner cap on simple-git's own child-process pool — paired with
      // the outer p-limit(8) so a single hot watcher can't monopolize.
      maxConcurrentProcesses: GIT_CONCURRENCY,
    });
  }

  /** Add a listener. First subscriber spins up watchers. **Listener
   *  fires only on subsequent changes** — call `refresh()` separately
   *  if you need the current state. Splitting "register for changes"
   *  from "fetch now" lets callers (e.g. the router, which embeds the
   *  initial snapshot in its subscribe response) avoid receiving the
   *  same snapshot twice. Returns an unsubscribe function. */
  subscribe(listener: GitStatusListener): () => void {
    if (this.disposed) throw new Error("GitWatcher is disposed");
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.startWatching();
    return () => this.unsubscribe(listener);
  }

  unsubscribe(listener: GitStatusListener): void {
    this.listeners.delete(listener);
    if (this.listeners.size === 0) this.stopWatching();
  }

  /** Run a status fetch, honoring cache + in-flight dedup. Public so
   *  callers can prime the cache or force a re-read after a known
   *  mutation (e.g. a commit Claude just ran). */
  async refresh(): Promise<GitStatus> {
    if (this.cachedStatus && Date.now() - this.cacheAt < STATUS_CACHE_TTL_MS) {
      return this.cachedStatus;
    }
    if (this.inFlight) return this.inFlight;
    const promise = gitLimit(() => this.fetchStatus())
      .then((s) => {
        this.cachedStatus = s;
        this.cacheAt = Date.now();
        return s;
      })
      .finally(() => {
        if (this.inFlight === promise) this.inFlight = null;
      });
    this.inFlight = promise;
    return promise;
  }

  /** Free all resources. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.clear();
    this.stopWatching();
  }

  private startWatching(): void {
    if (this.disposed) return;
    const gitDir = path.join(this.cwd, ".git");
    if (existsSync(gitDir)) {
      try {
        this.headWatcher = fsWatch(path.join(gitDir, "HEAD"), () =>
          this.onWatchEvent(),
        );
      } catch {
        // .git/HEAD may not exist in a freshly-init'd bare-ish state;
        // self-heal will pick it up.
      }
      const refsDir = path.join(gitDir, "refs", "heads");
      if (existsSync(refsDir)) {
        try {
          this.refsWatcher = fsWatch(refsDir, { recursive: true }, () =>
            this.onWatchEvent(),
          );
        } catch {
          // ignore
        }
      }
    }
    // Self-heal runs regardless — even non-repo dirs may get `git init`'d
    // later, and the working-tree-change blind spot needs covering.
    this.startSelfHealTimer();
  }

  private startSelfHealTimer(): void {
    if (this.selfHealTimer) return;
    this.selfHealTimer = setInterval(() => {
      this.cachedStatus = null;
      void this.refresh()
        .then((s) => this.notify(s))
        .catch(() => undefined);
    }, SELF_HEAL_INTERVAL_MS);
  }

  private stopWatching(): void {
    this.headWatcher?.close();
    this.refsWatcher?.close();
    this.headWatcher = null;
    this.refsWatcher = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.selfHealTimer) clearInterval(this.selfHealTimer);
    this.debounceTimer = null;
    this.selfHealTimer = null;
  }

  private onWatchEvent(): void {
    if (this.disposed) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.cachedStatus = null;
      void this.refresh()
        .then((s) => this.notify(s))
        .catch(() => undefined);
    }, DEBOUNCE_MS);
  }

  private notify(status: GitStatus): void {
    for (const cb of this.listeners) {
      try {
        cb(status);
      } catch {
        // A misbehaving listener mustn't take down siblings.
      }
    }
  }

  /** Strictly for tests — number of currently-attached listeners. */
  listenerCount(): number {
    return this.listeners.size;
  }

  private async fetchStatus(): Promise<GitStatus> {
    let isRepo: boolean;
    try {
      isRepo = await this.git.checkIsRepo();
    } catch {
      isRepo = false;
    }
    if (!isRepo) return NON_REPO_STATUS(this.project);

    // Resolve a comparison ref so `+N -M` matches user intuition
    // ("what have I done since I last synced") rather than just
    // working-tree dirt. When the branch has an upstream (typical
    // for main / pushed feature branches), diff against it — that
    // covers unpushed local commits + staged + working-tree changes
    // in one shot. With no upstream, fall back to HEAD (= just
    // uncommitted). Either way, untracked files get summed in
    // separately because `git diff` never sees them.
    const statusResult = await this.git.status().catch(() => null);
    const comparisonRef =
      statusResult?.tracking && statusResult.tracking.trim().length > 0
        ? statusResult.tracking
        : "HEAD";

    const [diffResult, untrackedAdditions] = await Promise.all([
      this.git.diffSummary([comparisonRef]).catch(() => null),
      this.countUntrackedAdditions(),
    ]);

    return {
      isRepo: true,
      project: this.project,
      branch: statusResult?.current ?? null,
      ahead: statusResult?.ahead ?? 0,
      behind: statusResult?.behind ?? 0,
      insertions: (diffResult?.insertions ?? 0) + untrackedAdditions,
      deletions: diffResult?.deletions ?? 0,
      isDirty: (statusResult?.files.length ?? 0) > 0 || untrackedAdditions > 0,
    };
  }

  /**
   * Sum line counts of untracked, non-binary, non-huge files. `git
   * diff` doesn't include them, but tools like Claude Desktop and
   * Paseo do — every line of a new file is a user-authored addition,
   * and ignoring them under-counts the `+N` number dramatically.
   *
   * Caps mirror Paseo's heuristic: max 500 files, max 256 KiB per
   * file, skip files with a null byte in their first 512 bytes
   * (rough binary detection). Anything past those caps is silently
   * skipped — the resulting count is "useful" rather than "exact".
   */
  private async countUntrackedAdditions(): Promise<number> {
    try {
      const out = await this.git.raw([
        "ls-files",
        "--others",
        "--exclude-standard",
      ]);
      const files = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      let additions = 0;
      for (const rel of files.slice(0, UNTRACKED_MAX_FILES)) {
        const abs = path.resolve(this.cwd, rel);
        try {
          const stat = await statFile(abs);
          if (!stat.isFile()) continue;
          if (stat.size === 0) continue;
          if (stat.size > UNTRACKED_MAX_FILE_BYTES) continue;
          if (await isLikelyBinary(abs, stat.size)) continue;
          const content = await readFile(abs, "utf-8");
          const normalized = content.replace(/\r\n/g, "\n");
          const lines = normalized.split("\n").length;
          additions += normalized.endsWith("\n") ? lines - 1 : lines;
        } catch {
          // Permission denied, symlink-to-nowhere, etc. — skip.
        }
      }
      return additions;
    } catch {
      return 0;
    }
  }
}

/** Sniff the first 512 bytes for a null byte. Cheap heuristic that
 *  excludes most real binaries (images, video, archives) without
 *  parsing extensions; matches Paseo's approach. */
async function isLikelyBinary(absPath: string, size: number): Promise<boolean> {
  const fd = await openFile(absPath, "r");
  try {
    const buf = Buffer.alloc(Math.min(UNTRACKED_BINARY_SNIFF_BYTES, size));
    await fd.read(buf, 0, buf.length, 0);
    return buf.includes(0);
  } finally {
    await fd.close();
  }
}

/**
 * Singleton-ish per-daemon registry mapping `cwd` → `GitWatcher`. Multiple
 * subscribers (different connections / different sessions on the same
 * cwd) share one underlying watcher + cache. The watcher stops its
 * fs.watch handles when its last subscriber leaves, but the instance
 * stays in the map so the next subscriber on the same cwd reuses the
 * cache + warms up without re-creating SimpleGit.
 */
export class GitWatcherRegistry {
  private readonly watchers = new Map<string, GitWatcher>();

  getOrCreate(cwd: string): GitWatcher {
    let w = this.watchers.get(cwd);
    if (w === undefined) {
      w = new GitWatcher(cwd);
      this.watchers.set(cwd, w);
    }
    return w;
  }

  /** Dispose all watchers + drop the map. Called on daemon shutdown. */
  disposeAll(): void {
    for (const w of this.watchers.values()) w.dispose();
    this.watchers.clear();
  }

  /** Tests only. */
  size(): number {
    return this.watchers.size;
  }
}
