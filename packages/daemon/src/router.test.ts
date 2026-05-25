import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type {
  Command,
  DaemonFrame,
  EventDelta,
  SessionInfo,
  TimelineItem,
} from "@sidecodeapp/protocol";
import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "./command.js";
import type { DesktopSession } from "./desktop/sessions.js";
import { GitWatcherRegistry } from "./git-watch.js";
import { createCommandHandler } from "./router.js";
import { SessionRuntimeManager } from "./runtime/session-runtime-manager.js";
import type { SidecodeSessionMetadata } from "./sidecode-sessions.js";

function makeCtx(): {
  ctx: CommandContext;
  sent: DaemonFrame[];
  fireDisconnect: () => void;
} {
  const sent: DaemonFrame[] = [];
  const callbacks: Array<() => void> = [];
  return {
    sent,
    fireDisconnect: () => {
      for (const cb of callbacks) cb();
      callbacks.length = 0;
    },
    ctx: {
      send: (f) => sent.push(f),
      fingerprint: "0123456789abcdef",
      onDisconnect: (cb) => {
        callbacks.push(cb);
      },
      state: new Map(),
    },
  };
}

/** Default deps for tests that don't exercise listSessions. */
function makeDeps(
  overrides?: Partial<Parameters<typeof createCommandHandler>[0]>,
): Parameters<typeof createCommandHandler>[0] {
  return {
    continueOnDesktop: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    listSidecodeSessions: vi.fn().mockReturnValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    runtimeManager: new SessionRuntimeManager<EventDelta>(),
    hasSession: vi.fn().mockResolvedValue(true),
    writeSidecodeSession: vi.fn(),
    isShuttingDown: () => false,
    gitWatchers: new GitWatcherRegistry(),
    ...overrides,
  };
}

function makeDesktopSession(
  over: Partial<DesktopSession> = {},
): DesktopSession {
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
            model: "claude-opus-4-7[1m]",
            modelLabel: "Opus 4.7 1M",
            effort: "xhigh",
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
    await handler({ type: "listSessions", requestId: "ls-5", dir: "/x" }, ctx);
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
    await handler({ type: "listSessions", requestId: "ls-6", dir: "/x" }, ctx);
    expect(sent[0]).toMatchObject({
      type: "listSessions.response",
      sessions: [],
    });
  });

  // ─── sidecode union + lazy title-fill ──────────────────────────────────

  function makeSidecodeMeta(
    over: Partial<SidecodeSessionMetadata> = {},
  ): SidecodeSessionMetadata {
    return {
      sessionId: "local_sc-1",
      cliSessionId: "sc-1",
      cwd: "/Users/x/proj",
      originCwd: "/Users/x/proj",
      createdAt: 1777000000000,
      lastActivityAt: 1777000000700,
      isArchived: false,
      title: "",
      titleSource: "auto",
      completedTurns: 0,
      permissionMode: "bypassPermissions",
      ...over,
    };
  }

  it("unions sidecode entries with desktop entries (origin: sidecode-created)", async () => {
    const desktop = makeDesktopSession({
      cliSessionId: "dt-1",
      sessionId: "local_dt-1",
      lastActivityAt: 100,
      title: "Desktop one",
    });
    const sidecode = makeSidecodeMeta({
      cliSessionId: "sc-1",
      sessionId: "local_sc-1",
      lastActivityAt: 200,
      title: "Sidecode one",
    });
    const handler = createCommandHandler(
      makeDeps({
        listSessions: vi.fn().mockResolvedValue([desktop]),
        listSidecodeSessions: vi.fn().mockReturnValue([sidecode]),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler({ type: "listSessions", requestId: "ls-u" }, ctx);
    const res = sent[0] as { sessions: SessionInfo[] };
    expect(res.sessions).toHaveLength(2);
    // Sorted by lastActivityAt desc → sidecode (200) first.
    expect(res.sessions[0]).toMatchObject({
      cliSessionId: "sc-1",
      origin: "sidecode-created",
      title: "Sidecode one",
    });
    expect(res.sessions[1]).toMatchObject({
      cliSessionId: "dt-1",
      origin: "desktop-mirror",
      title: "Desktop one",
    });
  });

  it("when a session is in BOTH sources, sidecode wins (truth-source semantics)", async () => {
    const same = "shared-id";
    const desktop = makeDesktopSession({
      cliSessionId: same,
      sessionId: `local_${same}_dt`,
      title: "From desktop",
      lastActivityAt: 999,
    });
    const sidecode = makeSidecodeMeta({
      cliSessionId: same,
      sessionId: `local_${same}_sc`,
      title: "From sidecode",
      lastActivityAt: 100,
    });
    const handler = createCommandHandler(
      makeDeps({
        listSessions: vi.fn().mockResolvedValue([desktop]),
        listSidecodeSessions: vi.fn().mockReturnValue([sidecode]),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler({ type: "listSessions", requestId: "ls-d" }, ctx);
    const res = sent[0] as { sessions: SessionInfo[] };
    expect(res.sessions).toHaveLength(1);
    expect(res.sessions[0]).toMatchObject({
      cliSessionId: same,
      origin: "sidecode-created",
      title: "From sidecode",
    });
  });

  it("passes sidecode metadata title straight through (no SDK lookup at display time)", async () => {
    const sidecode = makeSidecodeMeta({
      cliSessionId: "sc-titled",
      title: "Refactor the auth module",
    });
    const handler = createCommandHandler(
      makeDeps({
        listSidecodeSessions: vi.fn().mockReturnValue([sidecode]),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler({ type: "listSessions", requestId: "ls-pt" }, ctx);
    const res = sent[0] as { sessions: SessionInfo[] };
    expect(res.sessions[0]?.title).toBe("Refactor the auth module");
  });

  it("converts empty sidecode title to undefined (defensive — should not happen post-creation)", async () => {
    const sidecode = makeSidecodeMeta({ title: "" });
    const handler = createCommandHandler(
      makeDeps({
        listSidecodeSessions: vi.fn().mockReturnValue([sidecode]),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler({ type: "listSessions", requestId: "ls-empty" }, ctx);
    const res = sent[0] as { sessions: SessionInfo[] };
    expect(res.sessions[0]?.title).toBeUndefined();
  });

  it("forwards cwd filter to both listSessions and listSidecodeSessions", async () => {
    const listSessions = vi.fn().mockResolvedValue([]);
    const listSidecodeSessions = vi.fn().mockReturnValue([]);
    const handler = createCommandHandler(
      makeDeps({ listSessions, listSidecodeSessions }),
    );
    const { ctx } = makeCtx();
    await handler(
      { type: "listSessions", requestId: "ls-cwd", dir: "/Users/x/proj" },
      ctx,
    );
    expect(listSessions).toHaveBeenCalledWith({ cwd: "/Users/x/proj" });
    expect(listSidecodeSessions).toHaveBeenCalledWith({ cwd: "/Users/x/proj" });
  });
});

describe("createCommandHandler — getMessages", () => {
  it("calls getMessages with cliSessionId; cwd undefined when caller omits it", async () => {
    const items = [
      { type: "user_message" as const, uuid: "u-1", text: "hi" },
      { type: "assistant_message" as const, uuid: "u-2", text: "hello" },
    ];
    const getMessages = vi.fn().mockResolvedValue(items);
    const handler = createCommandHandler(makeDeps({ getMessages }));
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "getMessages",
        requestId: "gm-1",
        cliSessionId: "cli-abc",
      },
      ctx,
    );
    expect(getMessages).toHaveBeenCalledWith("cli-abc", undefined);
    expect(sent).toEqual([
      {
        type: "getMessages.response",
        requestId: "gm-1",
        items,
      },
    ]);
  });

  it("forwards cwd hint when caller provides one", async () => {
    const getMessages = vi.fn().mockResolvedValue([]);
    const handler = createCommandHandler(makeDeps({ getMessages }));
    const { ctx } = makeCtx();
    await handler(
      {
        type: "getMessages",
        requestId: "gm-hint",
        cliSessionId: "cli-abc",
        cwd: "/Users/x/proj",
      },
      ctx,
    );
    expect(getMessages).toHaveBeenCalledWith("cli-abc", "/Users/x/proj");
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

  it("ships an empty items array when normalize returns []", async () => {
    const handler = createCommandHandler(
      makeDeps({ getMessages: vi.fn().mockResolvedValue([]) }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "getMessages",
        requestId: "gm-3",
        cliSessionId: "cli-empty",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "getMessages.response",
      items: [],
    });
  });
});

describe("createCommandHandler — unsupported commands", () => {
  it("replies error/unsupported with the inbound requestId", async () => {
    // deleteSession is reserved for V1+ (per project_sidecode_persistence
    // memory) — router falls through to the unsupported-default branch.
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "deleteSession", requestId: "del-1", sessionId: "s" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      code: "unsupported",
    });
    expect((sent[0] as { requestId?: string }).requestId).toBe("del-1");
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

describe("createCommandHandler — subscribe / unsubscribe", () => {
  it("subscribe replies with settled + cursor and starts fanning out events", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        getMessages: vi
          .fn()
          .mockResolvedValue([
            { type: "user_message", uuid: "u-1", text: "hi" },
          ]),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-1", sessionId: "S" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "subscribe.response",
      requestId: "sub-1",
      sessionId: "S",
      cursor: 0,
    });
    expect((sent[0] as { settled: TimelineItem[] }).settled).toEqual([
      { type: "user_message", uuid: "u-1", text: "hi" },
    ]);
    // Now emit events on the runtime — fanout should ctx.send `event` frames.
    const runtime = runtimeManager.get("S");
    if (!runtime) throw new Error("expected runtime to exist");
    runtime.addEvent({ kind: "turn_started" });
    runtime.addEvent({
      kind: "patch_text",
      uuid: "msg:0",
      deltaText: "hello",
    });
    expect(sent).toHaveLength(3); // subscribe.response + 2 event frames
    expect(sent[1]).toMatchObject({
      type: "event",
      sessionId: "S",
      cursor: 1,
      delta: { kind: "turn_started" },
    });
    expect(sent[2]).toMatchObject({
      type: "event",
      sessionId: "S",
      cursor: 2,
      delta: { kind: "patch_text", uuid: "msg:0", deltaText: "hello" },
    });
  });

  it("subscribe with sinceCursor=current skips replay (only live events)", async () => {
    // Daemon's contract: subscribe sends settled (from JSONL) + cursor at
    // subscribe time; subsequent fanout = events with cursor > that value.
    // Pre-existing buffer events shouldn't be replayed (settled covers them).
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    runtime.addEvent({ kind: "turn_started" }); // cursor 1
    runtime.addEvent({ kind: "turn_completed" }); // cursor 2

    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-2", sessionId: "S" },
      ctx,
    );
    // Only subscribe.response — no replay of cursor 1 / 2.
    expect(sent).toHaveLength(1);
    expect((sent[0] as { cursor: number }).cursor).toBe(2);

    // Future events (cursor > 2) flow through.
    runtime.addEvent({ kind: "turn_failed", error: "boom" });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({
      type: "event",
      cursor: 3,
      delta: { kind: "turn_failed", error: "boom" },
    });
  });

  it("re-subscribe to the same session on the same conn replaces the prior fanout", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-1", sessionId: "S" },
      ctx,
    );
    await handler(
      { type: "subscribe", requestId: "sub-2", sessionId: "S" },
      ctx,
    );
    // Manager should only carry ONE subscriber for this conn — the second
    // subscribe call dropped the first cb before registering the new one.
    const runtime = runtimeManager.get("S");
    if (!runtime) throw new Error("expected runtime");
    expect(runtime.subscriberCount).toBe(1);
    runtime.addEvent({ kind: "turn_started" });
    // Only ONE event frame emitted (no double-delivery).
    const eventFrames = sent.filter((f) => f.type === "event");
    expect(eventFrames).toHaveLength(1);
  });

  it("unsubscribe stops fanout and replies with the response frame", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-1", sessionId: "S" },
      ctx,
    );
    await handler(
      { type: "unsubscribe", requestId: "uns-1", sessionId: "S" },
      ctx,
    );
    expect(sent.at(-1)).toMatchObject({
      type: "unsubscribe.response",
      requestId: "uns-1",
    });
    // Manager has no subscribers anymore → addEvent fans out to nobody.
    const runtime = runtimeManager.get("S");
    if (!runtime) throw new Error("expected runtime");
    expect(runtime.subscriberCount).toBe(0);
    const before = sent.length;
    runtime.addEvent({ kind: "turn_started" });
    expect(sent.length).toBe(before);
  });

  it("unsubscribe for a session we don't have a sub for is a silent ack", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "unsubscribe", requestId: "uns-orphan", sessionId: "no-such" },
      ctx,
    );
    expect(sent).toEqual([
      { type: "unsubscribe.response", requestId: "uns-orphan" },
    ]);
  });

  it("ws disconnect (onDisconnect callback firing) clears all this conn's subs", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, fireDisconnect } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-1", sessionId: "S1" },
      ctx,
    );
    await handler(
      { type: "subscribe", requestId: "sub-2", sessionId: "S2" },
      ctx,
    );
    expect(runtimeManager.get("S1")?.subscriberCount).toBe(1);
    expect(runtimeManager.get("S2")?.subscriberCount).toBe(1);
    fireDisconnect();
    expect(runtimeManager.get("S1")?.subscriberCount).toBe(0);
    expect(runtimeManager.get("S2")?.subscriberCount).toBe(0);
  });

  it("two connections subscribed to the same session each get their own fanout", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const a = makeCtx();
    const b = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-a", sessionId: "S" },
      a.ctx,
    );
    await handler(
      { type: "subscribe", requestId: "sub-b", sessionId: "S" },
      b.ctx,
    );
    const runtime = runtimeManager.get("S");
    if (!runtime) throw new Error("expected runtime");
    expect(runtime.subscriberCount).toBe(2);
    runtime.addEvent({ kind: "turn_started" });
    expect(a.sent.filter((f) => f.type === "event")).toHaveLength(1);
    expect(b.sent.filter((f) => f.type === "event")).toHaveLength(1);
    // Disconnecting only `a` doesn't affect `b`.
    a.fireDisconnect();
    expect(runtime.subscriberCount).toBe(1);
    runtime.addEvent({ kind: "turn_completed" });
    expect(a.sent.filter((f) => f.type === "event")).toHaveLength(1); // unchanged
    expect(b.sent.filter((f) => f.type === "event")).toHaveLength(2);
  });

  it("subscribe error path: getMessages rejects → error frame, no runtime sub registered", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        getMessages: vi.fn().mockRejectedValue(new Error("disk read failed")),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribe", requestId: "sub-x", sessionId: "S" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "sub-x",
      code: "internal",
      message: expect.stringContaining("disk read failed"),
    });
    // Runtime was getOrCreate'd but no subscriber registered (subscribe
    // throws before runtime.subscribe runs).
    expect(runtimeManager.get("S")?.subscriberCount).toBe(0);
  });
});

// ─── sendPrompt + interrupt + shuttingDown ────────────────────────────────
//
// These tests use a hand-rolled queryFactory that returns an empty,
// immediately-completing iterator — we only care about the handler's
// orchestration (path decision, runtime state, response shape), not what
// the SDK does with the prompt afterward. F2's run-query.test.ts covers
// the consumer-loop side.

function emptyQueryFactory(): typeof import("@anthropic-ai/claude-agent-sdk").query {
  return ((_params: unknown) => {
    async function* gen(): AsyncGenerator<never, void> {}
    const it = gen();
    return Object.assign(it, {
      interrupt: vi.fn(async () => {}),
      close: vi.fn(),
    }) as never;
  }) as never;
}

describe("createCommandHandler — sendPrompt", () => {
  it("resume path: existing session → ensureSessionLoop with mode=resume; turn_started emitted", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const writeMeta = vi.fn();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(true),
        writeSidecodeSession: writeMeta,
        queryFactory: emptyQueryFactory(),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-1",
        sessionId: "S",
        text: "hello",
      },
      ctx,
    );
    expect(sent.at(-1)).toEqual({
      type: "sendPrompt.response",
      requestId: "sp-1",
    });
    // Resume path: NO sidecode metadata written (Desktop / CLI already
    // own the session's local_*.json).
    expect(writeMeta).not.toHaveBeenCalled();
    // Runtime was created and pushPrompt fired turn_started into the buffer.
    const runtime = runtimeManager.get("S");
    if (!runtime) throw new Error("expected runtime");
    expect(runtime.currentCursor).toBeGreaterThanOrEqual(1);
  });

  it("create path: new session + cwd → writes sidecode metadata before spawning query", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const writeMeta = vi.fn();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(false),
        writeSidecodeSession: writeMeta,
        queryFactory: emptyQueryFactory(),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-2",
        sessionId: "new-uuid",
        text: "first message",
        cwd: "/Users/me/proj",
      },
      ctx,
    );
    expect(writeMeta).toHaveBeenCalledExactlyOnceWith({
      cliSessionId: "new-uuid",
      cwd: "/Users/me/proj",
      firstPrompt: "first message",
    });
    expect(sent.at(-1)).toEqual({
      type: "sendPrompt.response",
      requestId: "sp-2",
    });
  });

  it("create path without cwd → invalid_message error, no runtime spawned", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const writeMeta = vi.fn();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        hasSession: vi.fn().mockResolvedValue(false),
        writeSidecodeSession: writeMeta,
        queryFactory: emptyQueryFactory(),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-3",
        sessionId: "new-uuid",
        text: "hi",
        // cwd missing
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "sp-3",
      code: "invalid_message",
      message: expect.stringContaining("cwd is required"),
    });
    expect(writeMeta).not.toHaveBeenCalled();
    expect(runtimeManager.has("new-uuid")).toBe(false);
  });

  it("rejected during shutdown → error frame, no runtime side-effect", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const writeMeta = vi.fn();
    const handler = createCommandHandler(
      makeDeps({
        runtimeManager,
        writeSidecodeSession: writeMeta,
        isShuttingDown: () => true,
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "sp-shut",
        sessionId: "S",
        text: "hi",
        cwd: "/x",
      },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "sp-shut",
      message: expect.stringContaining("shutting down"),
    });
    expect(writeMeta).not.toHaveBeenCalled();
    expect(runtimeManager.has("S")).toBe(false);
  });
});

describe("createCommandHandler — interrupt", () => {
  it("calls runtime.query.interrupt() and emits turn_canceled to subscribers", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    const interruptMock = vi.fn(async () => {});
    runtime.query = {
      interrupt: interruptMock,
      close: () => {},
    };
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "interrupt", requestId: "int-1", sessionId: "S" },
      ctx,
    );
    expect(interruptMock).toHaveBeenCalledOnce();
    expect(sent).toEqual([{ type: "interrupt.response", requestId: "int-1" }]);
    // turn_canceled landed in the runtime buffer for any subscriber to see.
    const events: EventDelta[] = [];
    runtime.subscribe((e) => events.push(e.payload), 0);
    expect(events).toContainEqual({ kind: "turn_canceled" });
  });

  it("interrupt on a session with no active runtime → silent ack (no-op)", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "interrupt", requestId: "int-orphan", sessionId: "no-such" },
      ctx,
    );
    expect(sent).toEqual([
      { type: "interrupt.response", requestId: "int-orphan" },
    ]);
  });

  it("interrupt error path: query.interrupt() rejects → error frame", async () => {
    const runtimeManager = new SessionRuntimeManager<EventDelta>();
    const runtime = runtimeManager.getOrCreate("S");
    runtime.query = {
      interrupt: vi.fn().mockRejectedValue(new Error("control_lost")),
      close: () => {},
    };
    const handler = createCommandHandler(makeDeps({ runtimeManager }));
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "interrupt", requestId: "int-fail", sessionId: "S" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      requestId: "int-fail",
      code: "internal",
      message: expect.stringContaining("control_lost"),
    });
  });
});

describe("createCommandHandler — subscribeGitStatus / unsubscribeGitStatus", () => {
  // Uses a real GitWatcherRegistry against a tmp non-git directory. The
  // happy snapshot for non-repo dirs is deterministic (`isRepo:false`,
  // all numeric fields zero) so we can assert the wire shape without
  // invoking the `git` binary or fs.watch.
  let cwd: string;
  let registry: GitWatcherRegistry;

  function makeGitDeps() {
    cwd = mkdtempSync(path.join(tmpdir(), "sidecode-router-git-"));
    registry = new GitWatcherRegistry();
    return makeDeps({ gitWatchers: registry });
  }

  function cleanup() {
    registry.disposeAll();
    rmSync(cwd, { recursive: true, force: true });
  }

  it("replies with a non-repo snapshot for a plain directory", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribeGitStatus", requestId: "g1", cwd } satisfies Command,
      ctx,
    );
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const response = sent.find((f) => f.type === "subscribeGitStatus.response");
    expect(response).toBeDefined();
    expect(response).toMatchObject({
      type: "subscribeGitStatus.response",
      requestId: "g1",
      cwd,
      status: {
        isRepo: false,
        project: path.basename(cwd),
        branch: null,
        ahead: 0,
        behind: 0,
        insertions: 0,
        deletions: 0,
        isDirty: false,
      },
    });
    cleanup();
  });

  it("unsubscribe responds even when nothing was subscribed", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "unsubscribeGitStatus",
        requestId: "g2",
        cwd,
      } satisfies Command,
      ctx,
    );
    expect(sent).toEqual([
      { type: "unsubscribeGitStatus.response", requestId: "g2" },
    ]);
    cleanup();
  });

  it("disconnect cleans up the per-conn subscription", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx, fireDisconnect } = makeCtx();
    await handler(
      { type: "subscribeGitStatus", requestId: "g3", cwd } satisfies Command,
      ctx,
    );
    const watcher = registry.getOrCreate(cwd);
    expect(watcher.listenerCount()).toBe(1);
    fireDisconnect();
    expect(watcher.listenerCount()).toBe(0);
    cleanup();
  });

  it("re-subscribe on same conn replaces the previous listener", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx } = makeCtx();
    await handler(
      { type: "subscribeGitStatus", requestId: "g4a", cwd } satisfies Command,
      ctx,
    );
    await handler(
      { type: "subscribeGitStatus", requestId: "g4b", cwd } satisfies Command,
      ctx,
    );
    const watcher = registry.getOrCreate(cwd);
    // Two subscribe calls on the same connection should leave exactly
    // one listener attached, not two.
    expect(watcher.listenerCount()).toBe(1);
    cleanup();
  });
});

// ─── Filesystem browser (listDirectory + getFilesystemRoots) ─────────────────

/**
 * Build a fixture directory tree at a fresh tmpdir for browser tests:
 *
 *   <root>/
 *     alpha/                  ← subdirectory (alpha sort tester)
 *     beta/
 *     zebra/                  ← directory; lowercase sort vs Alpha
 *     .hidden/                ← hidden directory
 *     README.md               ← file
 *     .env                    ← hidden file
 *     image.png               ← file (predictable size)
 *
 * Returned helpers let each test populate exactly what it needs.
 */
function makeBrowserFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "router-browser-"));
  for (const dir of ["alpha", "beta", "zebra", ".hidden"]) {
    mkdirSync(path.join(root, dir));
  }
  writeFileSync(path.join(root, "README.md"), "hello\n");
  writeFileSync(path.join(root, ".env"), "SECRET=x\n");
  writeFileSync(path.join(root, "image.png"), "fake-png-bytes");
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("createCommandHandler — listDirectory", () => {
  it("returns only directories by default, sorted alpha case-insensitive", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld1",
          path: root,
        } satisfies Command,
        ctx,
      );
      expect(sent).toHaveLength(1);
      const res = sent[0];
      expect(res.type).toBe("listDirectory.response");
      if (res.type !== "listDirectory.response") throw new Error("type guard");
      expect(res.path).toBe(root);
      expect(res.parent).toBe(path.dirname(root));
      // No files (default includeFiles=false), no hidden (default
      // includeHidden=false); alpha case-insensitive within kind:
      // alpha → beta → zebra.
      expect(res.entries.map((e) => e.name)).toEqual([
        "alpha",
        "beta",
        "zebra",
      ]);
      expect(res.entries.every((e) => e.kind === "directory")).toBe(true);
      // No stats on dir-only entries.
      expect(res.entries.every((e) => e.size === undefined)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("includes hidden entries when includeHidden=true (still no files by default)", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld2",
          path: root,
          includeHidden: true,
        } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "listDirectory.response")
        throw new Error("expected response");
      // .hidden directory now shown; .env file still filtered by !includeFiles.
      expect(sent[0].entries.map((e) => e.name)).toEqual([
        ".hidden",
        "alpha",
        "beta",
        "zebra",
      ]);
    } finally {
      cleanup();
    }
  });

  it("surfaces files (kind only, no size/modifiedAt in V0) when includeFiles=true", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld3",
          path: root,
          includeFiles: true,
        } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "listDirectory.response")
        throw new Error("expected response");
      // Dirs first (alpha, beta, zebra), then files (image.png, README.md).
      // .env / .hidden still filtered (no includeHidden).
      expect(sent[0].entries.map((e) => e.name)).toEqual([
        "alpha",
        "beta",
        "zebra",
        "image.png",
        "README.md",
      ]);
      const readme = sent[0].entries.find((e) => e.name === "README.md");
      expect(readme?.kind).toBe("file");
      // V0 deliberately leaves size + modifiedAt undefined; the per-
      // entry stat path is deferred until we know whether we want
      // per-call stat, lazy-on-visible-row, or native bulk-stat.
      expect(readme?.size).toBeUndefined();
      expect(readme?.modifiedAt).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("expands ~ to HOME", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "listDirectory", requestId: "ld4", path: "~" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "listDirectory.response")
      throw new Error("expected response");
    // Daemon should have resolved "~" to homedir; echoed path matches.
    expect(sent[0].path).toBe(homedir());
  });

  it("returns not_found error for ENOENT path", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "listDirectory",
        requestId: "ld5",
        path: "/nonexistent-path-for-test-abc123",
      } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "error") throw new Error("expected error frame");
    expect(sent[0].code).toBe("not_found");
    expect(sent[0].requestId).toBe("ld5");
  });

  it("returns not_a_directory error when path is a file", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld6",
          path: path.join(root, "README.md"),
        } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "error") throw new Error("expected error frame");
      expect(sent[0].code).toBe("not_a_directory");
    } finally {
      cleanup();
    }
  });

  it("reports parent=null at the filesystem root", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "listDirectory", requestId: "ld7", path: "/" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "listDirectory.response")
      throw new Error("expected response");
    expect(sent[0].path).toBe("/");
    expect(sent[0].parent).toBeNull();
  });
});

describe("createCommandHandler — getFilesystemRoots", () => {
  function makeSidecodeMeta(
    over: Partial<SidecodeSessionMetadata> = {},
  ): SidecodeSessionMetadata {
    return {
      sessionId: "local_test",
      cliSessionId: "cli-test",
      cwd: "/Users/x/proj",
      originCwd: "/Users/x/proj",
      createdAt: 1700000000000,
      lastActivityAt: 1700000000000,
      isArchived: false,
      title: "t",
      titleSource: "auto",
      completedTurns: 0,
      permissionMode: "bypassPermissions",
      ...over,
    };
  }

  it("returns home/desktop/documents derived from os.homedir", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "getFilesystemRoots", requestId: "fr1" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "getFilesystemRoots.response")
      throw new Error("expected response");
    const home = homedir();
    expect(sent[0].home).toBe(home);
    expect(sent[0].desktop).toBe(path.join(home, "Desktop"));
    expect(sent[0].documents).toBe(path.join(home, "Documents"));
    expect(sent[0].recentCwds).toEqual([]); // no sessions = no recents
  });

  it("aggregates recent cwds from desktop + sidecode sources, deduped, existence-filtered, sorted desc", async () => {
    // Use tmpdir for existing cwds so the existence check actually
    // resolves on the real filesystem.
    const existingA = mkdtempSync(path.join(tmpdir(), "fr-cwdA-"));
    const existingB = mkdtempSync(path.join(tmpdir(), "fr-cwdB-"));
    const staleC = "/Users/nope/this-was-deleted-test-xyz";
    try {
      const handler = createCommandHandler(
        makeDeps({
          listSessions: vi.fn().mockResolvedValue([
            // Same cwd as sidecode below — should dedupe with the
            // LATEST lastActivityAt of the two ending up in the result.
            makeDesktopSession({
              cwd: existingA,
              lastActivityAt: 1700000000100,
            }),
            // Stale path; should be dropped by existence filter.
            makeDesktopSession({ cwd: staleC, lastActivityAt: 1700000001000 }),
          ]),
          listSidecodeSessions: vi.fn().mockReturnValue([
            makeSidecodeMeta({
              cwd: existingA,
              lastActivityAt: 1700000000900,
            }),
            makeSidecodeMeta({
              cwd: existingB,
              lastActivityAt: 1700000000500,
            }),
          ]),
        }),
      );
      const { ctx, sent } = makeCtx();
      await handler(
        { type: "getFilesystemRoots", requestId: "fr2" } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "getFilesystemRoots.response")
        throw new Error("expected response");
      // existingA wins existingB on lastActivityAt (900 > 500); staleC dropped.
      expect(sent[0].recentCwds.map((r) => r.path)).toEqual([
        existingA,
        existingB,
      ]);
      // Dedup keeps the LATER lastActivityAt (sidecode 900 > desktop 100).
      expect(sent[0].recentCwds[0].lastUsedAt).toBe(
        new Date(1700000000900).toISOString(),
      );
    } finally {
      rmSync(existingA, { recursive: true, force: true });
      rmSync(existingB, { recursive: true, force: true });
    }
  });

  it("caps recentCwds at 10 even when more exist", async () => {
    const cwds: string[] = [];
    for (let i = 0; i < 15; i++) {
      cwds.push(mkdtempSync(path.join(tmpdir(), `fr-cap-${i}-`)));
    }
    try {
      const handler = createCommandHandler(
        makeDeps({
          listSessions: vi.fn().mockResolvedValue(
            cwds.map((cwd, i) =>
              makeDesktopSession({
                cwd,
                lastActivityAt: 1700000000000 + i,
              }),
            ),
          ),
        }),
      );
      const { ctx, sent } = makeCtx();
      await handler(
        { type: "getFilesystemRoots", requestId: "fr3" } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "getFilesystemRoots.response")
        throw new Error("expected response");
      expect(sent[0].recentCwds).toHaveLength(10);
      // Sorted desc means the LAST 10 we inserted come first.
      expect(sent[0].recentCwds[0].path).toBe(cwds[14]);
    } finally {
      for (const c of cwds) rmSync(c, { recursive: true, force: true });
    }
  });
});

describe("createCommandHandler — getModels", () => {
  it("returns non-deprecated MODEL_METADATA entries with the wire shape", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "getModels", requestId: "gm1" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "getModels.response")
      throw new Error("expected getModels.response");
    // Daemon owns MODEL_METADATA; we don't pin the exact list here (it
    // grows every model launch) but we DO pin invariants the iOS picker
    // depends on: non-empty, exactly one default, no deprecated entries.
    expect(sent[0].models.length).toBeGreaterThan(0);
    const defaults = sent[0].models.filter((m) => m.isDefault);
    expect(defaults).toHaveLength(1);
    for (const m of sent[0].models) {
      expect(typeof m.model).toBe("string");
      expect(typeof m.displayName).toBe("string");
      expect(typeof m.isDefault).toBe("boolean");
    }
  });

  it("includes supportedEffortLevels for models that declare them", async () => {
    // Spot-check: at least one current model carries effort levels.
    // Verifies the optional-field spread in the handler isn't dropping them.
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "getModels", requestId: "gm2" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "getModels.response")
      throw new Error("expected getModels.response");
    const withEffort = sent[0].models.filter(
      (m) => m.supportedEffortLevels !== undefined,
    );
    expect(withEffort.length).toBeGreaterThan(0);
  });
});
