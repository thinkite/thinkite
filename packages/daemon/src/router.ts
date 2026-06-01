import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  DirectoryEntry,
  EventDelta,
  SessionInfo,
  TimelineItem,
  TurnUsage,
} from "@sidecodeapp/protocol";
import {
  isWhitelistedCommand,
  parseSlashCommand,
  SLASH_COMMANDS,
} from "@sidecodeapp/protocol";
import type { CommandHandler } from "./command.js";
import type { ContinueOnDesktopTarget } from "./desktop/continue-on-desktop.js";
import type { DesktopSession } from "./desktop/sessions.js";
import type { GitWatcherRegistry } from "./git-watch.js";
import { MODEL_METADATA, prettyModel } from "./models-metadata.js";
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
   * Also returns `initialUsage` extracted from the last assistant
   * message's raw envelope (SDK's `SessionMessage.message: unknown`
   * preserves the Anthropic `usage` payload that normalize() then
   * strips for TimelineItem). subscribe.response forwards it so the
   * iOS context meter renders immediately on resume rather than
   * waiting for the next live turn. Undefined when the session has no
   * assistant messages, or its last assistant message lacked a usage
   * payload. Computed in the same getSessionMessages() call as the
   * items — no extra SDK round-trip.
   *
   * `cwd` is an optional hint. When omitted, SDK scans every project key —
   * robust for fork sessions where the JSONL location isn't deterministic.
   *
   * SDK's `listSessions` is shunned (test noise per feedback file) but
   * `getSessionMessages` is per-id deterministic and safe to use.
   */
  getMessages: (
    cliSessionId: string,
    cwd?: string,
  ) => Promise<{ items: TimelineItem[]; initialUsage?: TurnUsage }>;
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
  /**
   * Process-wide epoch nonce. Generated once on daemon boot and stable
   * for the lifetime of the process. Returned to clients on every
   * `subscribe.response` so they can pass it back as `sinceEpoch` on
   * reconnect — a mismatch (= daemon restarted, in-memory ring buffers
   * are fresh) forces the subscribe handler to fall back to the cold
   * path (full settled snapshot) instead of attempting an incremental
   * replay that would silently drop events.
   *
   * Why a single process-wide value (not per-session): the runtime ring
   * buffer is the resource whose contents we're gating on, and that
   * lives or dies with the daemon process. A per-session epoch would
   * be more precise (only bump on that session's buffer rotation,
   * e.g. compaction-driven cursor renumber) but adds bookkeeping
   * without buying anything for V0 — every realistic "I can't serve
   * sinceCursor" case is "the whole process restarted." V0.5+ may
   * split this when compact-prune lands.
   *
   * Why expose it as a value, not a getter: it's literally a string
   * constant for the process lifetime; a function would just obscure
   * that. Tests inject a deterministic value (e.g. `"test-epoch"`)
   * to make assertions stable.
   */
  epoch: string;
}

// ─── Per-connection ctx.state keys (G2: subscriptions) ─────────────────────
//
// Router uses ctx.state — a free-form Map<string, unknown> scoped to the
// ws connection — to track per-conn subscriptions. We pick the key here
// once and namespace everything router-side under "router:".

const SUBS_KEY = "router:subs";
/** Per-conn slot for the SINGLE active subscribeSessions listener
 *  (#17 daemon-wide SessionState stream). Different from SUBS_KEY (per-
 *  session transcript fanout) so the two can't collide. The slot holds the
 *  unsubscribe-fn directly — there's only one subscribeSessions per peer
 *  by design (last-write-wins snapshot, no per-session bookkeeping). */
const SESSION_STATES_SUB_KEY = "router:sessionStatesSub";

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
      case "subscribeSessions": {
        // #17 daemon-wide SessionState fan-out. Single subscription per
        // peer (idempotent re-subscribe drops the prior fanout). The
        // manager owns disk-read + memory-union under `getAllSessionStates`
        // — router just forwards initial snapshot + wires the live
        // listener envelope. No cursor / no replay: SessionState is a
        // last-write-wins snapshot, the iOS TanStack DB collection
        // upserts by sessionId and resolves order via useLiveQuery.
        try {
          // Drop prior subscribeSessions listener on this peer if any —
          // a re-subscribe should NOT double-deliver. Same pattern as
          // the per-session `subscribe` handler does for SubsMap.
          const previous = ctx.state.get(SESSION_STATES_SUB_KEY) as
            | (() => void)
            | undefined;
          if (previous !== undefined) previous();

          const { initial, unsubscribe } =
            deps.runtimeManager.subscribeSessionStates({
              onChange: (sessionId, state) => {
                ctx.send({
                  type: "session_state_changed",
                  sessionId,
                  state,
                });
              },
              onRemove: (sessionId) => {
                // V0 never fires this (no user-driven delete) but the
                // wire path is here for V0.5+ when remove lands.
                ctx.send({
                  type: "session_state_removed",
                  sessionId,
                });
              },
            });

          ctx.state.set(SESSION_STATES_SUB_KEY, unsubscribe);
          ctx.onDisconnect(unsubscribe);

          // Response goes AFTER the listener is attached but BEFORE any
          // live frame could be enqueued — frame ordering is monotonic
          // over the DataChannel, so as long as the response goes out
          // synchronously after attach the client sees response → events
          // in correct order. (Compared to the per-session subscribe,
          // there's no "replay missed cursors" gap here — initial is
          // already the full snapshot and live events are last-write-
          // wins, so missing one is recoverable on the next edge.)
          ctx.send({
            type: "subscribeSessions.response",
            requestId: cmd.requestId,
            initial,
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
      case "subscribe": {
        try {
          const sessionId = cmd.sessionId;
          const runtime = deps.runtimeManager.getOrCreate(sessionId);

          // If iOS re-subscribes to the same session on the same connection
          // (e.g. after a quick navigate-away-and-back), drop the previous
          // fanout cb so we don't double-deliver events.
          const subs = getOrCreateSubs(ctx);
          const previous = subs.get(sessionId);
          if (previous !== undefined) previous();

          // ─── Warm vs cold path ──────────────────────────────────────
          //
          // Warm path: client passed sinceCursor + sinceEpoch matches
          // the current process epoch AND the runtime's ring still has
          // every event with cursor > sinceCursor. We return EMPTY
          // settled[] + recovered:true, then runtime.subscribe replays
          // the gap synchronously (so the replayed event frames arrive
          // immediately after the response).
          //
          // Cold path: any of the above fails (no resume hint, daemon
          // restart bumped the epoch, or sinceCursor predates the ring
          // because >500 events accumulated during the disconnect). We
          // re-read the full settled snapshot from JSONL + recovered:
          // false, signaling the client to truncate and start over.
          //
          // Ring-buffer completeness check: every event in (sinceCursor,
          // currentCursor] must still be present. The buffer holds
          // events with cursors in [oldestCursor, currentCursor], so
          // the first event we'd need to replay is sinceCursor+1; that
          // exists iff sinceCursor+1 >= oldestCursor (equivalently
          // sinceCursor >= oldestCursor - 1). Edge case: buffer empty
          // → oldestCursor null → any sinceCursor >= currentCursor is
          // trivially complete (nothing to replay).
          const currentEpoch = deps.epoch;
          const oldestCursor = runtime.oldestCursor;
          const currentCursor = runtime.currentCursor;
          const epochOk =
            cmd.sinceCursor !== undefined &&
            cmd.sinceEpoch !== undefined &&
            cmd.sinceEpoch === currentEpoch;
          const bufferOk =
            cmd.sinceCursor !== undefined &&
            (oldestCursor === null
              ? cmd.sinceCursor >= currentCursor
              : cmd.sinceCursor + 1 >= oldestCursor);
          const canRecover = epochOk && bufferOk;

          if (canRecover) {
            // Warm path. No JSONL read, no initialUsage (client already
            // has it from before — sending it again would clobber the
            // live `latestUsage` state the iOS hook maintains).
            //
            // Important: response goes out BEFORE runtime.subscribe so
            // the wire order is response → replayed events → live tail.
            // Without this ordering, the client would see event frames
            // with cursors > sinceCursor arriving before it knew the
            // subscribe was accepted (frame ordering is monotonic over
            // a single DataChannel, but client state machine treats
            // pre-response events as orphans).
            ctx.send({
              type: "subscribe.response",
              requestId: cmd.requestId,
              sessionId,
              settled: [],
              cursor: currentCursor,
              epoch: currentEpoch,
              recovered: true,
            });
            const sinceCursor = cmd.sinceCursor;
            const unsubscribe = runtime.subscribe((event) => {
              ctx.send({
                type: "event",
                sessionId,
                cursor: event.cursor,
                delta: event.payload,
              });
            }, sinceCursor);
            subs.set(sessionId, unsubscribe);
            ctx.onDisconnect(unsubscribe);
            return;
          }

          // Cold path — two flavors:
          //
          //   (A) **In-memory settled** (the race-free path). run-query
          //       refreshes runtime.settled + runtime.settledCursor on
          //       every turn boundary, AT a moment when the SDK iterator
          //       is paused so no addEvent can race. If settled is
          //       populated, we serve from memory atomically with the
          //       cursor + epoch + latestUsage. Replay events in
          //       (settledCursor, currentCursor] from the ring buffer
          //       — these events are from any in-progress turn AFTER
          //       the snapshot, so they touch items NOT in settled
          //       (no patch_text overwriting final assistant text).
          //
          //   (B) **JSONL fallback** (the lazy-init path). Used when:
          //       - First subscribe for a session before its first
          //         turn completes (settled still null)
          //       - Desktop-mirror read-only sessions (no SDK loop
          //         in this daemon → settled never populates)
          //       This path has the old race window (await JSONL read
          //       while events may land in the buffer); kept for
          //       compatibility but transparently displaced by path A
          //       after one turn.
          let settled: TimelineItem[];
          let settledCursor: number;
          let initialUsage: TurnUsage | undefined;

          if (runtime.settled !== null) {
            // Path A — atomic in-memory read. No await between fields.
            settled = runtime.settled;
            settledCursor = runtime.settledCursor;
            initialUsage = runtime.latestUsage ?? undefined;
          } else {
            // Path B — lazy init. The cursor snapshot is taken AFTER
            // the await; race window exists (see Path A's comment).
            const got = await deps.getMessages(sessionId);
            settled = got.items;
            initialUsage = got.initialUsage;
            settledCursor = runtime.currentCursor;
            // Memoize ONLY when an SDK loop is currently running for
            // this session — turn-boundary refresh (run-query.ts) is
            // what keeps the memo current, and that path only fires
            // while query is non-null. Without this gate, Desktop-
            // mirror sessions (SDK loop runs in Desktop, not here)
            // would memoize once and then serve stale data forever
            // since nothing in this daemon process invalidates it.
            // Same for previously-owned sessions whose SDK loop has
            // exited — settled would be stale.
            //
            // Cost of NOT memoizing: every cold-path subscribe for
            // Desktop-mirror sessions re-reads JSONL (~30ms local SSD).
            // Acceptable because: (a) back-nav within gcTime hits the
            // cached collection without re-subscribing at all, (b)
            // post-gcTime re-mounts are rare in real usage.
            if (runtime.query !== null) {
              runtime.settled = settled;
              runtime.settledCursor = settledCursor;
              if (initialUsage !== undefined)
                runtime.latestUsage = initialUsage;
            }
          }
          const cursor = runtime.currentCursor;

          // Response first (mirrors warm-path ordering for consistency).
          // Then runtime.subscribe at settledCursor — replays events
          // in (settledCursor, cursor] from the ring buffer + registers
          // the live fanout.
          ctx.send({
            type: "subscribe.response",
            requestId: cmd.requestId,
            sessionId,
            settled,
            cursor,
            epoch: currentEpoch,
            recovered: false,
            initialUsage,
          });
          const unsubscribe = runtime.subscribe((event) => {
            ctx.send({
              type: "event",
              sessionId,
              cursor: event.cursor,
              delta: event.payload,
            });
          }, settledCursor);
          subs.set(sessionId, unsubscribe);
          // ws.onclose → unsubscribe automatically. Safe to call twice
          // (runtime.subscribe's returned closure is idempotent), so an
          // explicit unsubscribe RPC followed by ws close is fine.
          ctx.onDisconnect(unsubscribe);
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

        // V0 slash-command whitelist (defense-in-depth — iOS's
        // `useSlashCommandHandler` runs the same check before this RPC
        // ever fires; if either side has a bug, the other catches it).
        //
        // Source of truth: packages/protocol/src/slash-commands.ts
        //
        //   - Unknown `/foo`               → unsupported, rejected
        //   - Whitelisted `passthrough`    → fall through to the SDK as
        //                                    raw text (`/init`, `/review`,
        //                                    `/compact`)
        //   - Whitelisted `intercept`      → rejected — the client should
        //                                    have dispatched locally
        //                                    instead of sending text
        //                                    (`/clear`, `/model`).
        //
        // Non-slash text always falls through.
        const slash = parseSlashCommand(cmd.text);
        if (slash !== null) {
          if (!isWhitelistedCommand(slash.name)) {
            ctx.send({
              type: "error",
              requestId: cmd.requestId,
              code: "unsupported",
              message: `/${slash.name} isn't a supported sidecode V0 command`,
            });
            return;
          }
          if (SLASH_COMMANDS[slash.name].handling === "intercept") {
            ctx.send({
              type: "error",
              requestId: cmd.requestId,
              code: "unsupported",
              message:
                `/${slash.name} is an intercept-handling command — ` +
                `client should dispatch locally, not send as text`,
            });
            return;
          }
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

          const mode: "create" | "resume" = exists ? "resume" : "create";

          // Persist sidecode metadata on the CREATE path BEFORE
          // getOrCreate so the runtime's currentModel gets seeded from
          // the fresh states entry — otherwise the runtime starts with
          // null and the first notifyStateChanged would regress
          // states.model back to undefined. Resume-path metadata
          // updates are owned by the `setSessionSelection` RPC.
          if (mode === "create") {
            deps.runtimeManager.createSessionFromPrompt({
              cliSessionId: cmd.sessionId,
              cwd: cmd.cwd as string,
              firstPrompt: cmd.text,
              ...(cmd.model !== undefined ? { model: cmd.model } : {}),
            });
          }
          const runtime = deps.runtimeManager.getOrCreate(cmd.sessionId);

          // Idempotent — second sendPrompt for same session reuses the
          // existing loop. mode/cwd/model are only consulted on the
          // FIRST call (when ensureSessionLoop actually spawns the SDK
          // query); subsequent calls return the existing promise and
          // ignore the options. On runtime respawn (e.g., daemon
          // restart) cmd.model acts as the resume-time SDK initial
          // option so SDK starts with the session's last picked model
          // without waiting for a setSessionSelection round-trip.
          ensureSessionLoop(runtime, {
            mode,
            cwd: cmd.cwd,
            model: cmd.model,
            queryFactory: deps.queryFactory,
          });
          // pushPrompt emits turn_started synchronously before the SDK
          // even sees the message — iOS flips the spinner immediately.
          // Forward the client-supplied user_message uuid (when present) so
          // the synthesized append reuses it and the client's optimistic
          // bubble dedupes by key.
          pushPrompt(runtime, cmd.text, cmd.images, cmd.userMessageUuid);

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
      case "setSessionSelection": {
        // Pick-time commit from the iOS input-bar picker. Apply to the
        // live runtime first; only write metadata if the control call
        // succeeds, so on-disk model stays in lockstep with what the
        // SDK actually has.
        //
        // Failure cascade: runtime apply throws → catch fires → error
        // frame returned, metadata UNTOUCHED. iOS sees the error and
        // rolls back the optimistic picker update via react-query's
        // onError handler. Realistic trigger: model not allowed by
        // the user's account.
        //
        // Deferred case: no live runtime (Desktop-mirror session that
        // user hasn't sent a prompt into yet). Skip the apply step
        // but still update metadata — the value gets picked up as SDK
        // initial option on the first sendPrompt via ensureSessionLoop.
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
          const runtime = deps.runtimeManager.get(cmd.sessionId);
          // Use applyFlagSettings carrying `model` — per upstream docs
          // this behaves identically to the dedicated `setModel()`
          // setter. Keeping one entrypoint simplifies the test seam.
          if (cmd.model !== undefined && runtime?.query?.applyFlagSettings) {
            await runtime.query.applyFlagSettings({ model: cmd.model });
          }
          // Manager-owned: updates runtime.currentModel (fires
          // onStateChanged → notifyStateChanged → memory cache + disk
          // persist + #17 fan-out to every iOS subscriber) AND falls
          // back to a direct persist+fan-out for sessions without a
          // live runtime. Returns `changed` so we can gate the CCR
          // metadata broadcast on actual transitions.
          const changed = deps.runtimeManager.setModel(
            cmd.sessionId,
            cmd.model,
          );
          // #17 — broadcast to CCR via worker external_metadata so a
          // claude.ai tab opened on the same cse_ session sees the new
          // model immediately (without waiting for the next assistant
          // frame's per-turn `message.model`). Gated on `changed` so a
          // no-op set doesn't trigger a redundant PUT. Best-effort:
          // bridge-transport swallows write errors so a flaky CCR
          // transport can't fail this RPC.
          if (changed) {
            runtime?.bridge?.reportMetadata?.({
              model: cmd.model ?? null,
            });
          }
          ctx.send({
            type: "setSessionSelection.response",
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
      case "getModels": {
        // Bootstrap RPC iOS calls once when the picker opens. Daemon owns
        // the source of truth (`MODEL_METADATA`) so iOS doesn't ship its
        // own copy; new models land via daemon release. Deprecated entries
        // are filtered here — historical Desktop sessions still need them
        // for `prettyModel` label rendering, but the picker should never
        // surface them as new-session choices.
        //
        // Order = source-declaration order in MODEL_METADATA (current
        // models first). Synchronous, no I/O — just a table walk.
        const models = Object.entries(MODEL_METADATA)
          .filter(([, meta]) => !meta.deprecated)
          .map(([key, meta]) => ({
            model: key,
            displayName: meta.displayName,
            isDefault: meta.isDefault === true,
            ...(meta.description !== undefined
              ? { description: meta.description }
              : {}),
            ...(meta.contextWindow !== undefined
              ? { contextWindow: meta.contextWindow }
              : {}),
          }));
        ctx.send({
          type: "getModels.response",
          requestId: cmd.requestId,
          models,
        });
        return;
      }
      case "interrupt": {
        const runtime = deps.runtimeManager.get(cmd.sessionId);
        // Interrupt is best-effort: no active runtime / no in-flight query
        // means there's nothing to interrupt. Still ack — matches the
        // unsubscribe-orphan policy.
        if (runtime?.query) {
          try {
            // Mark BEFORE interrupt() (synchronously, before the await) so
            // the in-flight turn's terminal envelope is in scope when it
            // drains: the SDK ends an interrupted turn with an
            // `error_during_execution` result, which handleResultEnvelope
            // would otherwise surface as a spurious turn_failed. The flag
            // makes it recognize the cancel instead.
            runtime.interrupted = true;
            await runtime.query.interrupt();
            // Emit turn_canceled directly into the runtime so all
            // subscribers see the cancel immediately. The SDK's subsequent
            // error_during_execution result is swallowed (interrupted
            // flag), so the cancel isn't doubled by a turn_failed.
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
    // `model` carries the RAW string from disk (`claude-opus-4-7[1m]`
    // etc.) so iOS can equality-check it; `modelLabel` is the pretty
    // version for display. Both optional but populated here when on disk.
    model: d.model || undefined,
    modelLabel: d.model ? prettyModel(d.model) : undefined,
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
    // empty for a properly-created session.
    title: s.title || undefined,
    // `model` is persisted in sidecode metadata at creation and on every
    // setSessionSelection pick. Surface it (+ its display label) so the
    // iOS picker chip reflects the chosen model and survives a list
    // refetch — without this the chip would blank out after the
    // collection reconciles against listSessions.
    model: s.model || undefined,
    modelLabel: s.model ? prettyModel(s.model) : undefined,
    isArchived: s.isArchived,
  };
}

/**
 * Convert raw model IDs like "claude-opus-4-7[1m]" to display strings like
 * "Opus 4.7". Tolerates unknown shapes by falling through.
 */

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
