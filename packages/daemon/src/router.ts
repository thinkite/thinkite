import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  DirectoryEntry,
  EventDelta,
  SessionInfo,
  TimelineItem,
} from "@sidecodeapp/protocol";
import type { CommandHandler } from "./command.js";
import type { ContinueOnDesktopTarget } from "./desktop/continue-on-desktop.js";
import type { DesktopSession } from "./desktop/sessions.js";
import type { GitWatcherRegistry } from "./git-watch.js";
import {
  ensureSessionLoop,
  pushPrompt,
  type SessionLoopOptions,
} from "./runtime/run-query.js";
import type { SessionRuntimeManager } from "./runtime/session-runtime-manager.js";
import type { SidecodeSessionMetadata } from "./sidecode-sessions.js";

export interface RouterDeps {
  continueOnDesktop: (target: ContinueOnDesktopTarget) => Promise<void>;
  /**
   * List Desktop-mirrored sessions. With `{ cwd }` filter to that
   * project; with `{}` return all sessions across every Desktop env-pair
   * (iOS groups client-side). Daemon never folds in SDK `listSessions()`
   * — that returns automation / test noise (see feedback).
   */
  listSessions: (opts: { cwd?: string }) => Promise<DesktopSession[]>;
  /**
   * List sidecode-created sessions from `<home>/sessions/local_*.json`.
   * Same `cwd` filter semantics as `listSessions`. Sync because it's a
   * trivial fs.readdir + JSON.parse over a small (~tens) directory;
   * Promise.all in the handler tolerates plain array returns.
   */
  listSidecodeSessions: (opts: { cwd?: string }) => SidecodeSessionMetadata[];
  /**
   * Read the full message transcript for a CLI session, normalized into a
   * flat TimelineItem[]. Backed by the SDK's `getSessionMessages` which parses
   * `~/.claude/projects/<projectKey>/<cliSessionId>.jsonl`; daemon then runs
   * normalize() to flatten ContentBlock[] and pair tool_use+tool_result.
   * Empty array if the session file is missing — caller distinguishes via
   * UX, not error.
   *
   * `cwd` is an optional hint. When omitted, SDK scans every project key —
   * robust for fork sessions where the JSONL location isn't deterministic.
   *
   * SDK's `listSessions` is shunned (test noise per feedback file) but
   * `getSessionMessages` is per-id deterministic and safe to use.
   */
  getMessages: (cliSessionId: string, cwd?: string) => Promise<TimelineItem[]>;
  /**
   * Per-session runtime manager. G2's subscribe/unsubscribe handlers
   * register their fanout callbacks on the runtime; G3 wires sendPrompt /
   * interrupt through here too. Daemon owns one manager per process
   * (created in daemon.start, drained on shutdown).
   */
  runtimeManager: SessionRuntimeManager<EventDelta>;
  /**
   * Existence check for a CLI session. Wraps SDK's `getSessionInfo` —
   * undefined ⇒ session JSONL not on disk yet ⇒ sendPrompt's "create"
   * branch fires (sidecode mints a fresh `local_<id>.json`). Returning
   * a defined record means the session exists and we should resume.
   *
   * Daemon's wiring uses SDK's `getSessionInfo(id)` directly. Test seam:
   * stub this dep to control the create-vs-resume branch without
   * touching the filesystem.
   */
  hasSession: (cliSessionId: string) => Promise<boolean>;
  /**
   * Persist sidecode-side metadata for a session sidecode is creating
   * now. Called from the create-branch of sendPrompt before
   * ensureSessionLoop spawns the SDK query. `firstPrompt` is the user's
   * opening message text — daemon snapshots it as the auto-title at this
   * point so the iOS sidebar has a meaningful label from session
   * inception (no display-time SDK lookup, no later refresh — see
   * sidecode-sessions.ts:buildNewSidecodeSession for the rationale).
   * Tests stub this to a no-op to avoid touching `<home>/sessions/`.
   */
  writeSidecodeSession: (input: {
    cliSessionId: string;
    cwd: string;
    firstPrompt: string;
  }) => void;
  /**
   * Whether the daemon is mid-shutdown. Router gates sendPrompt and
   * subscribe behind this — once shutdown starts, accepting new prompts
   * spawns runtimes that can't be drained cleanly (`manager.shutdown`
   * iterates a snapshot of the map). Returns `false` during normal
   * operation; flips `true` synchronously in `daemon.stop()` before
   * `manager.shutdown()` runs.
   */
  isShuttingDown: () => boolean;
  /**
   * Test seam for `ensureSessionLoop`'s `queryFactory` option. When
   * provided, sendPrompt forwards it through so router-level tests can
   * stub the SDK. Production omits this and the SDK's real `query` is
   * used.
   */
  queryFactory?: SessionLoopOptions["queryFactory"];
  /**
   * Per-daemon registry of `GitWatcher`s keyed by `cwd`. Shared across
   * connections so two iOS clients on the same project re-use one watch
   * + cache. Daemon disposes the whole registry on shutdown.
   */
  gitWatchers: GitWatcherRegistry;
}

// ─── Per-connection ctx.state keys (G2: subscriptions) ─────────────────────
//
// Router uses ctx.state — a free-form Map<string, unknown> scoped to the
// ws connection — to track per-conn subscriptions. We pick the key here
// once and namespace everything router-side under "router:".

const SUBS_KEY = "router:subs";

/** Per-conn map: sessionId → unsubscribe-fn returned by runtime.subscribe. */
type SubsMap = Map<string, () => void>;

function getOrCreateSubs(ctx: { state: Map<string, unknown> }): SubsMap {
  const existing = ctx.state.get(SUBS_KEY) as SubsMap | undefined;
  if (existing !== undefined) return existing;
  const created: SubsMap = new Map();
  ctx.state.set(SUBS_KEY, created);
  return created;
}

const GIT_SUBS_KEY = "router:gitSubs";

/** Per-conn map: cwd → unsubscribe-fn returned by GitWatcher.subscribe.
 *  Separate namespace from session subs so the two can't collide. */
type GitSubsMap = Map<string, () => void>;

function getOrCreateGitSubs(ctx: { state: Map<string, unknown> }): GitSubsMap {
  const existing = ctx.state.get(GIT_SUBS_KEY) as GitSubsMap | undefined;
  if (existing !== undefined) return existing;
  const created: GitSubsMap = new Map();
  ctx.state.set(GIT_SUBS_KEY, created);
  return created;
}

/**
 * Wire up the authenticated-command dispatcher.
 *
 * V0 W1 implements `continueOnDesktop` and `listSessions`. Every other
 * command type is answered with an `unsupported` error frame so iOS fails
 * loudly while the rest of the surface is built out in W2+.
 */
export function createCommandHandler(deps: RouterDeps): CommandHandler {
  return async (cmd, ctx) => {
    switch (cmd.type) {
      case "continueOnDesktop": {
        try {
          await deps.continueOnDesktop({
            cliSessionId: cmd.cliSessionId,
            desktopLocalSessionId: cmd.desktopLocalSessionId,
          });
          ctx.send({
            type: "continueOnDesktop.response",
            requestId: cmd.requestId,
            ok: true,
          });
        } catch (err) {
          ctx.send({
            type: "continueOnDesktop.response",
            requestId: cmd.requestId,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "listSessions": {
        // `dir` is optional: omitted = "all projects", iOS groups by cwd.
        try {
          const filter = cmd.dir ? { cwd: cmd.dir } : {};
          // Read both sources in parallel. Sidecode is sync but Promise.all
          // happily wraps plain values.
          const [desktopSessions, sidecodeSessions] = await Promise.all([
            deps.listSessions(filter),
            Promise.resolve(deps.listSidecodeSessions(filter)),
          ]);
          // Union by cliSessionId. Sidecode metadata is the truth source
          // for sessions sidecode created — if a session appears in both
          // (e.g. Desktop later mirrored a sidecode-created one), prefer
          // sidecode's record so user-set title / titleSource lock from
          // `/rename` doesn't get overridden by Desktop's auto-summary.
          //
          // Title comes straight from sidecode metadata, written at
          // session creation from the user's first prompt — no display-
          // time SDK lookup. See sidecode-sessions.ts for the rationale.
          const byCliSessionId = new Map<string, SessionInfo>();
          for (const d of desktopSessions) {
            byCliSessionId.set(d.cliSessionId, toSessionInfo(d));
          }
          for (const s of sidecodeSessions) {
            byCliSessionId.set(s.cliSessionId, toSessionInfoFromSidecode(s));
          }
          const sessions = Array.from(byCliSessionId.values()).sort(
            (a, b) => b.lastActivityAt - a.lastActivityAt,
          );
          ctx.send({
            type: "listSessions.response",
            requestId: cmd.requestId,
            sessions,
          });
        } catch (err) {
          ctx.send({
            type: "error",
            requestId: cmd.requestId,
            code: "internal",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "getMessages": {
        try {
          const items = await deps.getMessages(cmd.cliSessionId, cmd.cwd);
          ctx.send({
            type: "getMessages.response",
            requestId: cmd.requestId,
            items,
          });
        } catch (err) {
          ctx.send({
            type: "error",
            requestId: cmd.requestId,
            code: "internal",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "subscribe": {
        try {
          const runtime = deps.runtimeManager.getOrCreate(cmd.sessionId);
          // Settled snapshot taken atomically with the cursor below. Race
          // window: an event may land in the buffer between getMessages
          // (reads JSONL on disk) and runtime.subscribe (registers the
          // live fanout). V0 accepts this — see project_session_replay_model
          // memory; user-perceived gap is bounded by SDK flush latency.
          const settled = await deps.getMessages(cmd.sessionId);
          const cursor = runtime.currentCursor;

          // If iOS re-subscribes to the same session on the same connection
          // (e.g. after a quick navigate-away-and-back), drop the previous
          // fanout cb so we don't double-deliver events.
          const subs = getOrCreateSubs(ctx);
          const previous = subs.get(cmd.sessionId);
          if (previous !== undefined) previous();

          // sinceCursor=cursor → don't replay the buffer; iOS already has
          // settled state up to this point. Live deltas only from here.
          const sessionId = cmd.sessionId;
          const unsubscribe = runtime.subscribe((event) => {
            ctx.send({
              type: "event",
              sessionId,
              cursor: event.cursor,
              delta: event.payload,
            });
          }, cursor);
          subs.set(sessionId, unsubscribe);
          // ws.onclose → unsubscribe automatically. Safe to call twice
          // (runtime.subscribe's returned closure is idempotent), so an
          // explicit unsubscribe RPC followed by ws close is fine.
          ctx.onDisconnect(unsubscribe);

          ctx.send({
            type: "subscribe.response",
            requestId: cmd.requestId,
            sessionId,
            settled,
            cursor,
          });
        } catch (err) {
          ctx.send({
            type: "error",
            requestId: cmd.requestId,
            code: "internal",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "unsubscribe": {
        const subs = getOrCreateSubs(ctx);
        const unsubscribe = subs.get(cmd.sessionId);
        if (unsubscribe !== undefined) {
          unsubscribe();
          subs.delete(cmd.sessionId);
        }
        // Unsubscribing a session we don't have a sub for is a no-op (race
        // with ws.onclose, double-unsubscribe, or wrong session id) —
        // V0 silently acks rather than 404-ing.
        ctx.send({
          type: "unsubscribe.response",
          requestId: cmd.requestId,
        });
        return;
      }
      case "subscribeGitStatus": {
        try {
          const watcher = deps.gitWatchers.getOrCreate(cmd.cwd);
          const gitSubs = getOrCreateGitSubs(ctx);

          // Re-subscribe to the same cwd on the same conn replaces the old
          // listener — mirrors the `subscribe` handler's behavior for
          // session subs (rapid navigate-away-and-back).
          const previous = gitSubs.get(cmd.cwd);
          if (previous !== undefined) previous();

          const cwd = cmd.cwd;
          const unsubscribe = watcher.subscribe((status) => {
            ctx.send({ type: "gitStatus", cwd, status });
          });
          gitSubs.set(cwd, unsubscribe);
          // Auto-clean on DC.close. The closure is idempotent (GitWatcher
          // tolerates double-delete), so an explicit unsubscribeGitStatus
          // followed by DC.close is fine.
          ctx.onDisconnect(unsubscribe);

          // Initial snapshot in the response primes the iOS bar without
          // a follow-up event roundtrip. `GitWatcher.subscribe` is pure
          // registration — listener fires only on subsequent changes —
          // so this `refresh()` is the one and only initial delivery.
          const status = await watcher.refresh();
          ctx.send({
            type: "subscribeGitStatus.response",
            requestId: cmd.requestId,
            cwd,
            status,
          });
        } catch (err) {
          ctx.send({
            type: "error",
            requestId: cmd.requestId,
            code: "internal",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "unsubscribeGitStatus": {
        const gitSubs = getOrCreateGitSubs(ctx);
        const unsubscribe = gitSubs.get(cmd.cwd);
        if (unsubscribe !== undefined) {
          unsubscribe();
          gitSubs.delete(cmd.cwd);
        }
        ctx.send({
          type: "unsubscribeGitStatus.response",
          requestId: cmd.requestId,
        });
        return;
      }
      case "sendPrompt": {
        // Reject during shutdown: any new query we spawn now can't be
        // drained cleanly — manager.shutdown() iterates a snapshot.
        if (deps.isShuttingDown()) {
          ctx.send({
            type: "error",
            requestId: cmd.requestId,
            code: "internal",
            message: "daemon is shutting down",
          });
          return;
        }

        try {
          // Decide create-vs-resume from SDK's session existence check.
          // We don't reach into the filesystem ourselves — getSessionInfo
          // owns the projectKey-sanitization rule (see
          // project_session_replay_model memory).
          const exists = await deps.hasSession(cmd.sessionId);
          if (!exists && cmd.cwd === undefined) {
            ctx.send({
              type: "error",
              requestId: cmd.requestId,
              code: "invalid_message",
              message:
                "cwd is required when sendPrompt creates a new session " +
                "(no JSONL exists for this sessionId yet)",
            });
            return;
          }

          const runtime = deps.runtimeManager.getOrCreate(cmd.sessionId);
          const mode: "create" | "resume" = exists ? "resume" : "create";

          // Persist sidecode metadata FIRST, before spawning the SDK
          // query — that way if iOS reconnects mid-create, listSessions
          // already shows the entry. Resume path skips this (Desktop /
          // CLI already wrote their own metadata). The user's first
          // prompt becomes the auto-title; iOS sees the row labeled
          // immediately on the next listSessions call.
          if (mode === "create") {
            deps.writeSidecodeSession({
              cliSessionId: cmd.sessionId,
              cwd: cmd.cwd as string,
              firstPrompt: cmd.text,
            });
          }

          // Idempotent — second sendPrompt for same session reuses the
          // existing loop. Mode is only consulted on first call.
          ensureSessionLoop(runtime, {
            mode,
            cwd: cmd.cwd,
            queryFactory: deps.queryFactory,
          });
          // pushPrompt emits turn_started synchronously before the SDK
          // even sees the message — iOS flips the spinner immediately.
          pushPrompt(runtime, cmd.text, cmd.images);

          ctx.send({
            type: "sendPrompt.response",
            requestId: cmd.requestId,
          });
        } catch (err) {
          ctx.send({
            type: "error",
            requestId: cmd.requestId,
            code: "internal",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "listDirectory": {
        // Hierarchical browser for the iOS cwd / file picker. Workhorse
        // RPC: caller passes the path it wants to list (or "~" / "~/..."
        // for HOME-relative), daemon returns one level of entries.
        //
        // V0 scope: folder picker. `includeFiles=true` already surfaces
        // file entries through the filter below, but `size` /
        // `modifiedAt` stay undefined — per-entry stat is deferred to
        // V0.5+ when we decide between per-call stat, lazy-on-visible-
        // row, or native bulk-stat (see "高效拿 stats" design thread).
        const resolved = expandHomePath(cmd.path);
        try {
          const stat = await fs.stat(resolved);
          if (!stat.isDirectory()) {
            ctx.send({
              type: "error",
              requestId: cmd.requestId,
              code: "not_a_directory",
              message: `${resolved} is not a directory`,
            });
            return;
          }
          const dirents = await fs.readdir(resolved, { withFileTypes: true });
          // Cheap filter — only name + d_type from readdir, no extra
          // syscall. Order matters: dot-filter before file-filter so
          // an `includeHidden: true, includeFiles: false` request
          // still drops hidden FILES implicitly via the kind filter.
          const entries: DirectoryEntry[] = dirents
            .filter((d) => cmd.includeHidden || !d.name.startsWith("."))
            .filter((d) => cmd.includeFiles || d.isDirectory())
            .map((d) => ({
              name: d.name,
              path: path.join(resolved, d.name),
              kind: d.isDirectory()
                ? ("directory" as const)
                : ("file" as const),
            }));
          entries.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, {
              sensitivity: "base",
            });
          });
          // path.dirname("/") === "/" — that's our "at root" signal.
          const parentPath = path.dirname(resolved);
          ctx.send({
            type: "listDirectory.response",
            requestId: cmd.requestId,
            path: resolved,
            parent: parentPath === resolved ? null : parentPath,
            entries,
          });
        } catch (err) {
          const { code, message } = classifyFsError(err, resolved);
          ctx.send({ type: "error", requestId: cmd.requestId, code, message });
        }
        return;
      }
      case "getFilesystemRoots": {
        // Bootstrap RPC iOS calls once per session-create flow. Tells iOS
        // the daemon machine's HOME (so "~" expansion is server-side) +
        // gives a recents list aggregated from session history so the
        // picker has a useful starting point even on first launch.
        //
        // desktop/documents are stat-checked: macOS always has both,
        // but Linux headless / non-standard XDG locales may not — we
        // omit the field rather than send a path that 404s when iOS
        // tries to listDirectory on it.
        const home = os.homedir();
        try {
          const desktopPath = path.join(home, "Desktop");
          const documentsPath = path.join(home, "Documents");
          const [
            desktopSessions,
            sidecodeSessions,
            desktopExists,
            documentsExists,
          ] = await Promise.all([
            deps.listSessions({}),
            Promise.resolve(deps.listSidecodeSessions({})),
            fs
              .stat(desktopPath)
              .then((s) => s.isDirectory())
              .catch(() => false),
            fs
              .stat(documentsPath)
              .then((s) => s.isDirectory())
              .catch(() => false),
          ]);
          const recentCwds = await collectRecentCwds(
            desktopSessions,
            sidecodeSessions,
          );
          ctx.send({
            type: "getFilesystemRoots.response",
            requestId: cmd.requestId,
            home,
            ...(desktopExists ? { desktop: desktopPath } : {}),
            ...(documentsExists ? { documents: documentsPath } : {}),
            recentCwds,
          });
        } catch (err) {
          ctx.send({
            type: "error",
            requestId: cmd.requestId,
            code: "internal",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "interrupt": {
        const runtime = deps.runtimeManager.get(cmd.sessionId);
        // Interrupt is best-effort: no active runtime / no in-flight query
        // means there's nothing to interrupt. Still ack — matches the
        // unsubscribe-orphan policy.
        if (runtime?.query) {
          try {
            await runtime.query.interrupt();
            // Emit turn_canceled directly into the runtime so all
            // subscribers see the cancel even if the SDK doesn't fire its
            // own terminal envelope — turn_completed/turn_failed should
            // still arrive when the in-flight turn drains, but iOS gets
            // a fast UX signal here.
            runtime.addEvent({ kind: "turn_canceled" });
          } catch (err) {
            ctx.send({
              type: "error",
              requestId: cmd.requestId,
              code: "internal",
              message: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }
        ctx.send({
          type: "interrupt.response",
          requestId: cmd.requestId,
        });
        return;
      }
      default: {
        const requestId =
          "requestId" in cmd
            ? (cmd as { requestId: string }).requestId
            : undefined;
        ctx.send({
          type: "error",
          requestId,
          code: "unsupported",
          message: `command ${(cmd as { type: string }).type} not implemented in V0 W1`,
        });
        return;
      }
    }
  };
}

function toSessionInfo(d: DesktopSession): SessionInfo {
  return {
    sessionId: d.sessionId,
    cwd: d.cwd,
    originCwd: d.originCwd,
    lastActivityAt: d.lastActivityAt,
    origin: "desktop-mirror",
    cliSessionId: d.cliSessionId,
    title: d.title || undefined,
    model: prettyModel(d.model),
    completedTurns: d.completedTurns,
    isArchived: d.isArchived,
  };
}

function toSessionInfoFromSidecode(s: SidecodeSessionMetadata): SessionInfo {
  return {
    sessionId: s.sessionId,
    cwd: s.cwd,
    originCwd: s.originCwd,
    // V0 gap: sidecode's `lastActivityAt` is set at creation and never
    // updated, so the list ordering is "creation time" not real activity.
    // Surfacing JSONL mtime via getSessionInfo on every entry would fix
    // it but adds N file reads per list call — deferred until V0.5+.
    lastActivityAt: s.lastActivityAt,
    origin: "sidecode-created",
    cliSessionId: s.cliSessionId,
    // `title` is populated at session creation from the user's first
    // prompt (see sidecode-sessions.ts:buildNewSidecodeSession) — never
    // empty for a properly-created session. We don't fold model into
    // sidecode metadata yet (V0 only tracks permissionMode), so iOS
    // shows the row without a model chip; Desktop-mirrored entries
    // still carry it.
    title: s.title || undefined,
    completedTurns: s.completedTurns,
    isArchived: s.isArchived,
  };
}

/**
 * Convert raw model IDs like "claude-opus-4-7[1m]" to display strings like
 * "Opus 4.7". Tolerates unknown shapes by falling through.
 */
function prettyModel(raw: string): string {
  if (!raw) return "";
  const match = raw.match(/^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/i);
  if (!match) return raw;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  return `${family} ${match[2]}.${match[3]}`;
}

/**
 * Expand "~" / "~/..." to the daemon machine's HOME, then normalize via
 * `path.resolve` (collapses `..` / `.` segments, ensures absolute).
 * Other shapes (relative paths, "~user") pass through `resolve` as-is,
 * which is enough for iOS — it always sends absolute paths or the
 * literal "~" returned via `getFilesystemRoots`.
 */
function expandHomePath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

/** Map Node `fs` errors to protocol error codes. */
function classifyFsError(
  err: unknown,
  attemptedPath: string,
): { code: "not_found" | "permission_denied" | "internal"; message: string } {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: string }).code;
    if (code === "ENOENT")
      return { code: "not_found", message: `path not found: ${attemptedPath}` };
    if (code === "EACCES" || code === "EPERM")
      return {
        code: "permission_denied",
        message: `permission denied: ${attemptedPath}`,
      };
  }
  return {
    code: "internal",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Aggregate "recent cwds" for the picker sidebar. Union of Desktop
 * session cwds and sidecode session cwds, deduped (keep the most
 * recent lastActivityAt per cwd), filtered to paths that still exist
 * on disk (stale entries from deleted projects drop), sorted desc by
 * lastActivityAt, capped at 10.
 */
async function collectRecentCwds(
  desktopSessions: DesktopSession[],
  sidecodeSessions: SidecodeSessionMetadata[],
): Promise<{ path: string; lastUsedAt: string }[]> {
  // Dedup by cwd. Per-key value is the LATEST lastActivityAt across
  // both source sets — a cwd appearing in both contributes whichever
  // session was touched most recently.
  const latest = new Map<string, number>();
  const consume = (s: { cwd: string; lastActivityAt: number }) => {
    const prev = latest.get(s.cwd);
    if (prev === undefined || s.lastActivityAt > prev) {
      latest.set(s.cwd, s.lastActivityAt);
    }
  };
  for (const s of desktopSessions) consume(s);
  for (const s of sidecodeSessions) consume(s);

  // Check existence in parallel; drop entries whose path no longer
  // resolves to a directory on disk.
  const existenceChecks = await Promise.all(
    Array.from(latest.entries()).map(async ([cwd, lastActivityAt]) => {
      try {
        const stat = await fs.stat(cwd);
        return stat.isDirectory()
          ? { cwd, lastActivityAt, exists: true }
          : { cwd, lastActivityAt, exists: false };
      } catch {
        return { cwd, lastActivityAt, exists: false };
      }
    }),
  );
  return existenceChecks
    .filter((e) => e.exists)
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, 10)
    .map((e) => ({
      path: e.cwd,
      lastUsedAt: new Date(e.lastActivityAt).toISOString(),
    }));
}
