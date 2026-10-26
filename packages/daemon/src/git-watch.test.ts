import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type GitStatus, GitWatcher, isNoise } from "./git-watch.ts";

/**
 * Real-git integration tests. `simple-git` is itself just a `git` CLI
 * wrapper, so mocking it would test our mocks more than the contract.
 * tmpdir + a one-off init keeps each test isolated.
 *
 * The watch path gets two end-to-end cases (an edit, then a reset outside
 * the app) with a generous wait; debounce and self-heal timing are not
 * pinned down beyond that.
 */
describe("GitWatcher", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sidecode-git-watch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function initRepo(repoDir: string): void {
    // -b main avoids depending on the user's `init.defaultBranch` config.
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    // Local identity so commits don't error on hosts without global config.
    execFileSync("git", ["config", "user.email", "test@sidecode.app"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  }

  it("reports isRepo:false for a non-git directory", async () => {
    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.isRepo).toBe(false);
    expect(status.project).toBe(path.basename(dir));
    expect(status.branch).toBeNull();
    expect(status.insertions).toBe(0);
    expect(status.deletions).toBe(0);
    expect(status.isDirty).toBe(false);
    w.dispose();
  });

  it("reports branch + clean state after an initial commit", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.isDirty).toBe(false);
    expect(status.insertions).toBe(0);
    expect(status.deletions).toBe(0);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    w.dispose();
  });

  it("counts insertions vs the default branch (merge-base == HEAD on main)", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "line1\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });
    // Two new lines on top of the committed one.
    writeFileSync(path.join(dir, "a.txt"), "line1\nline2\nline3\n");

    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.isRepo).toBe(true);
    expect(status.isDirty).toBe(true);
    // On `main` the comparison ref is merge-base(main, HEAD) == HEAD, so
    // this measures uncommitted working-tree changes only.
    expect(status.insertions).toBe(2);
    expect(status.deletions).toBe(0);
    w.dispose();
  });

  it("counts vs default-branch merge-base: committed branch work + uncommitted + untracked", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "base.txt"), "1\n");
    execFileSync("git", ["add", "base.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });

    // Branch off main and commit 2 lines on the branch. No origin in the
    // test repo → the default branch resolves to the local "main".
    execFileSync("git", ["checkout", "-q", "-b", "feat"], { cwd: dir });
    writeFileSync(path.join(dir, "feat.txt"), "a\nb\n");
    execFileSync("git", ["add", "feat.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "feat work"], { cwd: dir });

    // Uncommitted tracked edit (+1) + an untracked file (+1).
    writeFileSync(path.join(dir, "base.txt"), "1\n2\n");
    writeFileSync(path.join(dir, "extra.txt"), "z\n");

    const w = new GitWatcher(dir);
    const status = await w.refresh();
    // vs merge-base(main, HEAD): committed feat.txt (+2) + uncommitted
    // base.txt (+1) + untracked extra.txt (+1) = 4 — NOT the 1 line a
    // vs-HEAD comparison would report.
    expect(status.insertions).toBe(4);
    expect(status.deletions).toBe(0);
    w.dispose();
  });

  it("counts untracked file lines on top of tracked diff", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "tracked.txt"), "x\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    // Modify tracked file → 1 insertion via `git diff`.
    writeFileSync(path.join(dir, "tracked.txt"), "x\ny\n");
    // Untracked file with 5 lines → 5 additions, summed in separately.
    writeFileSync(path.join(dir, "new.txt"), "a\nb\nc\nd\ne\n");

    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.isRepo).toBe(true);
    expect(status.isDirty).toBe(true);
    expect(status.insertions).toBe(1 + 5);
    expect(status.deletions).toBe(0);
    w.dispose();
  });

  it("skips binary files when counting untracked additions", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "marker.txt"), "x\n");
    execFileSync("git", ["add", "marker.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    // Untracked text file (3 lines) — should be counted.
    writeFileSync(path.join(dir, "added.txt"), "a\nb\nc\n");
    // Untracked binary-ish file (contains a null byte in first 512
    // bytes) — should be skipped by the sniff.
    writeFileSync(path.join(dir, "binary.bin"), Buffer.from([1, 0, 2, 3]));

    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.insertions).toBe(3);
    w.dispose();
  });

  it("flips isDirty true when only untracked files exist", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "tracked.txt"), "x\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    // No working-tree edit on a tracked file — only an untracked add.
    writeFileSync(path.join(dir, "new.txt"), "a\nb\n");

    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.isDirty).toBe(true);
    expect(status.insertions).toBe(2);
    w.dispose();
  });

  it("subscribe is pure registration — no initial snapshot fires", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "x\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    const w = new GitWatcher(dir);
    const got: GitStatus[] = [];
    const unsubscribe = w.subscribe((s) => got.push(s));
    // refresh() is the read API. The listener only sees subsequent
    // change-triggered pushes (debounced + invalidated cache).
    const snapshot = await w.refresh();
    // Drain any stray microtasks that might have queued a push.
    await new Promise((r) => setImmediate(r));
    expect(snapshot.branch).toBe("main");
    expect(snapshot.isDirty).toBe(false);
    expect(got).toEqual([]);
    unsubscribe();
    w.dispose();
  });

  it("a snapshot read with nothing watching is never stale", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "x\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });
    writeFileSync(path.join(dir, "a.txt"), "x\ny\n");

    const w = new GitWatcher(dir);
    expect((await w.refresh()).insertions).toBe(1);
    // A reset outside the app, inside the cache's 15 s.
    execFileSync("git", ["reset", "-q", "--hard"], { cwd: dir });
    expect((await w.refresh()).insertions).toBe(0);
    w.dispose();
  });

  /** Make `edit` until the watcher pushes: on a loaded macOS runner the
   *  first events of a just-started FSEvents stream can be lost, and the
   *  60 s self-heal is too slow to wait for. Once a push has arrived the
   *  stream is live, so later steps can make their change once. */
  async function editUntilPushed(
    got: GitStatus[],
    edit: () => void,
  ): Promise<void> {
    await vi.waitFor(
      () => {
        if (got.length === 0) edit();
        expect(got.length).toBeGreaterThan(0);
      },
      { timeout: 15_000, interval: 1000 },
    );
  }

  it("pushes working-tree edits and an outside reset", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "x\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    const w = new GitWatcher(dir);
    const got: GitStatus[] = [];
    const unsubscribe = w.subscribe((s) => got.push(s));
    await editUntilPushed(got, () =>
      writeFileSync(path.join(dir, "a.txt"), "x\ny\nz\n"),
    );
    await vi.waitFor(() => expect(got.at(-1)?.insertions).toBe(2), {
      timeout: 8000,
      interval: 100,
    });
    execFileSync("git", ["reset", "-q", "--hard"], { cwd: dir });
    await vi.waitFor(() => expect(got.at(-1)?.insertions).toBe(0), {
      timeout: 8000,
      interval: 100,
    });
    unsubscribe();
    w.dispose();
  }, 30_000);

  it("settles after a push instead of refreshing itself forever", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "x\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    const w = new GitWatcher(dir);
    const got: GitStatus[] = [];
    const unsubscribe = w.subscribe((s) => got.push(s));
    await editUntilPushed(got, () =>
      writeFileSync(path.join(dir, "a.txt"), "x\ny\n"),
    );
    await vi.waitFor(() => expect(got.at(-1)?.insertions).toBe(1), {
      timeout: 8000,
      interval: 100,
    });
    // A retried edit may still be on its way; start counting once quiet.
    let settled: number;
    do {
      settled = got.length;
      await new Promise((r) => setTimeout(r, 1500));
    } while (got.length !== settled);
    // Each refresh runs `git status`, which locks the index; another
    // client reading the repo does the same.
    execFileSync("git", ["status"], { cwd: dir });
    await new Promise((r) => setTimeout(r, 2500));
    expect(got.length).toBe(settled);
    unsubscribe();
    w.dispose();
  }, 30_000);

  it("isNoise drops object, log, index, lock and node_modules events", () => {
    expect(isNoise(".git/objects/ab/cdef")).toBe(true);
    expect(isNoise(".git/logs/HEAD")).toBe(true);
    expect(isNoise(".git/index")).toBe(true);
    expect(isNoise(".git/index.lock")).toBe(true);
    expect(isNoise(".git/refs/heads/main.lock")).toBe(true);
    expect(isNoise("node_modules/react/index.js")).toBe(true);
    expect(isNoise("packages/app/node_modules/x.js")).toBe(true);
    expect(isNoise(".git/HEAD")).toBe(false);
    expect(isNoise("bun.lock")).toBe(false);
    expect(isNoise(".git/refs/heads/main")).toBe(false);
    expect(isNoise("src/settings.ts")).toBe(false);
    expect(isNoise(null)).toBe(false);
  });

  it("dispose() is idempotent", () => {
    const w = new GitWatcher(dir);
    w.dispose();
    w.dispose();
    // subscribing after dispose throws — protects against stale callers.
    expect(() => w.subscribe(() => undefined)).toThrow();
  });
});
