import type { SessionInfo, TimelineItem } from "@sidecodeapp/protocol";
import type { ContinueOnDesktopTarget } from "./desktop/continue-on-desktop.js";
import type { DesktopSession } from "./desktop/sessions.js";
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
