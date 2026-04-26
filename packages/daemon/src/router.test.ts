import type { Command, DaemonFrame } from "@sidecodeapp/protocol";
import { describe, expect, it, vi } from "vitest";
import { createCommandHandler } from "./router.js";
import type { CommandContext } from "./ws-server.js";

function makeCtx(): { ctx: CommandContext; sent: DaemonFrame[] } {
  const sent: DaemonFrame[] = [];
  return {
    sent,
    ctx: {
      send: (f) => sent.push(f),
      fingerprint: "0123456789abcdef",
    },
  };
}

describe("createCommandHandler — continueOnDesktop", () => {
  it("calls continueOnDesktop with target fields and replies ok=true", async () => {
    const continueOnDesktop = vi.fn().mockResolvedValue(undefined);
    const handler = createCommandHandler({ continueOnDesktop });
    const { ctx, sent } = makeCtx();
    const cmd: Command = {
      type: "continueOnDesktop",
      requestId: "req-1",
      cliSessionId: "cli-abc",
      desktopLocalSessionId: "local_xyz",
    };
    await handler(cmd, ctx);
    expect(continueOnDesktop).toHaveBeenCalledWith({
      cliSessionId: "cli-abc",
      desktopLocalSessionId: "local_xyz",
    });
    expect(sent).toEqual([
      {
        type: "continueOnDesktop.response",
        requestId: "req-1",
        ok: true,
      },
    ]);
  });

  it("omits desktopLocalSessionId when caller didn't supply one", async () => {
    const continueOnDesktop = vi.fn().mockResolvedValue(undefined);
    const handler = createCommandHandler({ continueOnDesktop });
    const { ctx } = makeCtx();
    await handler(
      {
        type: "continueOnDesktop",
        requestId: "r",
        cliSessionId: "cli-only",
      },
      ctx,
    );
    expect(continueOnDesktop).toHaveBeenCalledWith({
      cliSessionId: "cli-only",
      desktopLocalSessionId: undefined,
    });
  });

  it("replies ok=false + error string when continueOnDesktop rejects", async () => {
    const continueOnDesktop = vi
      .fn()
      .mockRejectedValue(new Error("'open <url>' exited with code 1"));
    const handler = createCommandHandler({ continueOnDesktop });
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "continueOnDesktop",
        requestId: "req-2",
        cliSessionId: "cli-fail",
      },
      ctx,
    );
    expect(sent).toEqual([
      {
        type: "continueOnDesktop.response",
        requestId: "req-2",
        ok: false,
        error: "'open <url>' exited with code 1",
      },
    ]);
  });

  it("stringifies non-Error rejections for the error field", async () => {
    const continueOnDesktop = vi.fn().mockRejectedValue("string failure");
    const handler = createCommandHandler({ continueOnDesktop });
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "continueOnDesktop",
        requestId: "req-3",
        cliSessionId: "x",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      ok: false,
      error: "string failure",
    });
  });
});

describe("createCommandHandler — unsupported commands", () => {
  it("replies error/unsupported for listSessions (request/response with requestId)", async () => {
    const handler = createCommandHandler({
      continueOnDesktop: vi.fn(),
    });
    const { ctx, sent } = makeCtx();
    await handler({ type: "listSessions", requestId: "rq" }, ctx);
    expect(sent).toEqual([
      {
        type: "error",
        requestId: "rq",
        code: "unsupported",
        message: "command listSessions not implemented in V0 W1",
      },
    ]);
  });

  it("replies error/unsupported for fire-and-forget commands (no requestId)", async () => {
    const handler = createCommandHandler({
      continueOnDesktop: vi.fn(),
    });
    const { ctx, sent } = makeCtx();
    await handler({ type: "subscribe", sessionId: "s" }, ctx);
    expect(sent[0]).toMatchObject({
      type: "error",
      code: "unsupported",
    });
    expect((sent[0] as { requestId?: string }).requestId).toBeUndefined();
  });

  it("does NOT call continueOnDesktop for other command types", async () => {
    const continueOnDesktop = vi.fn();
    const handler = createCommandHandler({ continueOnDesktop });
    const { ctx } = makeCtx();
    await handler({ type: "stopTask", sessionId: "s" }, ctx);
    await handler({ type: "approve", requestId: "r", decision: "allow" }, ctx);
    expect(continueOnDesktop).not.toHaveBeenCalled();
  });
});
