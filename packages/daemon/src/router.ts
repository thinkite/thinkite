import type {
  EventDelta,
  SessionInfo,
  TimelineItem,
} from "@sidecodeapp/protocol";
import type { ContinueOnDesktopTarget } from "./desktop/continue-on-desktop.js";
import type { DesktopSession } from "./desktop/sessions.js";
import type { SessionRuntimeManager } from "./runtime/session-runtime-manager.js";
import type { CommandHandler } from "./ws-server.js";

export interface RouterDeps {
  continueOnDesktop: (target: ContinueOnDesktopTarget) => Promise<void>;
  /**
   * List sessions. With `{ cwd }` filter to that project; with `{}` return
   * all sessions across every Desktop env-pair (iOS groups client-side).
   * V0 W1 baseline reads only Desktop's `claude-code-sessions/` mirror;
   * V0.5+ unions in sidecode-DB entries. Daemon never folds in SDK
   * `listSessions()` — that returns automation / test noise (see feedback).
   */
  listSessions: (opts: { cwd?: string }) => Promise<DesktopSession[]>;
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
   * register their fanout callbacks on the runtime; G3+ will route
   * sendPrompt/interrupt through here too. Daemon owns one manager per
   * process (created in daemon.start, drained on shutdown).
   */
  runtimeManager: SessionRuntimeManager<EventDelta>;
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
          const desktopSessions = await deps.listSessions(
            cmd.dir ? { cwd: cmd.dir } : {},
          );
          const sessions: SessionInfo[] = desktopSessions.map(toSessionInfo);
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
