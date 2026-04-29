import type { Command, DaemonFrame } from "@sidecodeapp/protocol";
import { describe, expect, it, vi } from "vitest";
import type { DesktopSession } from "./desktop/sessions.js";
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

/** Default deps for tests that don't exercise listSessions. */
function makeDeps(overrides?: Partial<Parameters<typeof createCommandHandler>[0]>) {
  return {
    continueOnDesktop: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeDesktopSession(over: Partial<DesktopSession> = {}): DesktopSession {
  return {
    sessionId: "local_119c4694-f67a-4e16-b99c-140567c682fd",
    cliSessionId: "03f3f808-9702-4dda-82da-34a8b3f76879",
    cwd: "/Users/x/proj",
    originCwd: "/Users/x/proj",
    createdAt: 1777000000000,
    lastActivityAt: 1777000000500,
    model: "claude-opus-4-7[1m]",
    effort: "xhigh",
    isArchived: false,
    title: "Plan project folder structure",
    titleSource: "auto",
    permissionMode: "bypassPermissions",
    completedTurns: 21,
    filePath: "/path/to/local_119c4694.json",
    environmentOuter: "outer-uuid",
    environmentInner: "inner-uuid",
    ...over,
  };
}

describe("createCommandHandler — continueOnDesktop", () => {
  it("calls continueOnDesktop with target fields and replies ok=true", async () => {
    const continueOnDesktop = vi.fn().mockResolvedValue(undefined);
    const handler = createCommandHandler(makeDeps({ continueOnDesktop }));
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
    const handler = createCommandHandler(makeDeps({ continueOnDesktop }));
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
    const handler = createCommandHandler(makeDeps({ continueOnDesktop }));
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
    const handler = createCommandHandler(makeDeps({ continueOnDesktop }));
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

describe("createCommandHandler — listSessions", () => {
  it("calls listSessions with the requested cwd and maps results to SessionInfo", async () => {
    const desktopSession = makeDesktopSession();
    const listSessions = vi.fn().mockResolvedValue([desktopSession]);
    const handler = createCommandHandler(makeDeps({ listSessions }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "listSessions", requestId: "ls-1", dir: "/Users/x/proj" },
      ctx,
    );
    expect(listSessions).toHaveBeenCalledWith({ cwd: "/Users/x/proj" });
    expect(sent).toEqual([
      {
        type: "listSessions.response",
        requestId: "ls-1",
        sessions: [
          {
            sessionId: "local_119c4694-f67a-4e16-b99c-140567c682fd",
            cwd: "/Users/x/proj",
            originCwd: "/Users/x/proj",
            lastActivityAt: 1777000000500,
            origin: "desktop-mirror",
            cliSessionId: "03f3f808-9702-4dda-82da-34a8b3f76879",
            title: "Plan project folder structure",
            model: "Opus 4.7",
            completedTurns: 21,
            isArchived: false,
          },
        ],
      },
    ]);
  });

  it("converts empty title to undefined (so iOS shows the 'Untitled' fallback)", async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValue([makeDesktopSession({ title: "" })]);
    const handler = createCommandHandler(makeDeps({ listSessions }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "listSessions", requestId: "ls-2", dir: "/Users/x/proj" },
      ctx,
    );
    const res = sent[0] as { sessions: { title?: string }[] };
    expect(res.sessions[0]?.title).toBeUndefined();
  });

  it("preserves originCwd from a fork (cwd != originCwd)", async () => {
    const fork = makeDesktopSession({
      sessionId: "local_fork",
      cwd: "/Users/x/proj/worktrees/feature",
      originCwd: "/Users/x/proj",
      title: "Plan project folder structure (fork)",
    });
    const listSessions = vi.fn().mockResolvedValue([fork]);
    const handler = createCommandHandler(makeDeps({ listSessions }));
    const { ctx, sent } = makeCtx();
    await handler({ type: "listSessions", requestId: "ls-fork" }, ctx);
    const res = sent[0] as {
      sessions: Array<{ cwd: string; originCwd: string }>;
    };
    expect(res.sessions[0]?.cwd).toBe("/Users/x/proj/worktrees/feature");
    expect(res.sessions[0]?.originCwd).toBe("/Users/x/proj");
  });

  it("falls through unrecognized model strings as-is", async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValue([makeDesktopSession({ model: "weird-future-model" })]);
    const handler = createCommandHandler(makeDeps({ listSessions }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "listSessions", requestId: "ls-3", dir: "/Users/x/proj" },
      ctx,
    );
    const res = sent[0] as { sessions: { model?: string }[] };
    expect(res.sessions[0]?.model).toBe("weird-future-model");
  });

  it("calls reader with no cwd filter when dir is omitted (all projects)", async () => {
    const listSessions = vi.fn().mockResolvedValue([]);
    const handler = createCommandHandler(makeDeps({ listSessions }));
    const { ctx, sent } = makeCtx();
    await handler({ type: "listSessions", requestId: "ls-4" }, ctx);
    expect(listSessions).toHaveBeenCalledWith({});
    expect(sent[0]).toMatchObject({
      type: "listSessions.response",
      sessions: [],
    });
  });

  it("returns an error frame when the reader throws", async () => {
    const listSessions = vi.fn().mockRejectedValue(new Error("disk gone"));
    const handler = createCommandHandler(makeDeps({ listSessions }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "listSessions", requestId: "ls-5", dir: "/x" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "ls-5",
      code: "internal",
      message: "disk gone",
    });
  });

  it("returns an empty sessions array when reader returns []", async () => {
    const handler = createCommandHandler(
      makeDeps({ listSessions: vi.fn().mockResolvedValue([]) }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "listSessions", requestId: "ls-6", dir: "/x" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "listSessions.response",
      sessions: [],
    });
  });
});

describe("createCommandHandler — getMessages", () => {
  it("calls getMessages with cliSessionId + cwd and ships messages back", async () => {
    const messages = [
      {
        type: "user" as const,
        uuid: "u-1",
        sessionId: "cli-abc",
        message: { role: "user", content: "hi" },
      },
      {
        type: "assistant" as const,
        uuid: "u-2",
        sessionId: "cli-abc",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      },
    ];
    const getMessages = vi.fn().mockResolvedValue(messages);
    const handler = createCommandHandler(makeDeps({ getMessages }));
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "getMessages",
        requestId: "gm-1",
        cliSessionId: "cli-abc",
        cwd: "/Users/x/proj",
      },
      ctx,
    );
    expect(getMessages).toHaveBeenCalledWith("cli-abc", "/Users/x/proj");
    expect(sent).toEqual([
      {
        type: "getMessages.response",
        requestId: "gm-1",
        messages,
      },
    ]);
  });

  it("returns an error frame when getMessages throws", async () => {
    const getMessages = vi
      .fn()
      .mockRejectedValue(new Error("session file gone"));
    const handler = createCommandHandler(makeDeps({ getMessages }));
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "getMessages",
        requestId: "gm-2",
        cliSessionId: "cli-x",
        cwd: "/p",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "gm-2",
      code: "internal",
      message: "session file gone",
    });
  });

  it("ships an empty messages array when SDK returns []", async () => {
    const handler = createCommandHandler(
      makeDeps({ getMessages: vi.fn().mockResolvedValue([]) }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "getMessages",
        requestId: "gm-3",
        cliSessionId: "cli-empty",
        cwd: "/p",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "getMessages.response",
      messages: [],
    });
  });
});

describe("createCommandHandler — unsupported commands", () => {
  it("replies error/unsupported for fire-and-forget commands (no requestId)", async () => {
    const handler = createCommandHandler(makeDeps());
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
    const handler = createCommandHandler(makeDeps({ continueOnDesktop }));
    const { ctx } = makeCtx();
    await handler({ type: "stopTask", sessionId: "s" }, ctx);
    await handler({ type: "approve", requestId: "r", decision: "allow" }, ctx);
    expect(continueOnDesktop).not.toHaveBeenCalled();
  });
});
