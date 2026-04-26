import type { ContinueOnDesktopTarget } from "./desktop/continue-on-desktop.js";
import type { CommandHandler } from "./ws-server.js";

export interface RouterDeps {
  continueOnDesktop: (target: ContinueOnDesktopTarget) => Promise<void>;
}

/**
 * Wire up the authenticated-command dispatcher.
 *
 * V0 W1 implements only `continueOnDesktop`. Every other command type is
 * answered with an `unsupported` error frame so iOS can fail loudly while
 * the rest of the surface is built out in W2+. This keeps unwired iOS calls
 * from silently no-op'ing during integration.
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
      default: {
        const requestId =
          "requestId" in cmd ? (cmd as { requestId: string }).requestId : undefined;
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
