import type { Query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventDelta } from "@sidecodeapp/protocol";
import { describe, expect, it, vi } from "vitest";
import { ensureSessionLoop, pushPrompt } from "./run-query.js";
import { type RuntimeEvent, SessionRuntime } from "./session-runtime.js";

/**
 * Cheap test seam: build a fake Query that iterates a static array of
 * SDKMessages then exits. Production callers pass the SDK's real
 * `query()`. Casting through `unknown` skips the rest of Query's
 * surface (setModel/setPermissionMode/...) since `ensureSessionLoop`
 * only needs the AsyncGenerator + the runtime's RuntimeQueryHandle slot.
 *
 * The fake ignores the input `prompt` channel — tests don't care that
 * pushed prompts reach the SDK, only that emitted SDK messages produce
 * the right EventDeltas.
 */
function fakeQueryYielding(
  messages: readonly SDKMessage[],
): typeof import("@anthropic-ai/claude-agent-sdk").query {
  return ((_params: unknown) => {
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for (const m of messages) yield m;
    }
    const it = gen();
    return Object.assign(it, {
      interrupt: vi.fn(async () => {}),
      close: vi.fn(),
    }) as unknown as Query;
  }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
}

/** Drain a runtime's buffer into a plain payload array for assertions. */
function payloads(runtime: SessionRuntime<EventDelta>): EventDelta[] {
  const events: RuntimeEvent<EventDelta>[] = [];
  runtime.subscribe((e) => events.push(e), 0);
  return events.map((e) => e.payload);
}

// ─── Stream event scaffolding ────────────────────────────────────────

function messageStart(messageId: string): SDKMessage {
  return {
    type: "stream_event",
    uuid: `env-${messageId}-start`,
    session_id: "s",
    parent_tool_use_id: null,
    event: { type: "message_start", message: { id: messageId } },
  } as unknown as SDKMessage;
}

function messageStop(): SDKMessage {
  return {
    type: "stream_event",
    uuid: "env-stop",
    session_id: "s",
    parent_tool_use_id: null,
    event: { type: "message_stop" },
  } as unknown as SDKMessage;
}

function contentBlockStartText(index: number): SDKMessage {
  return {
    type: "stream_event",
    uuid: `env-cbs-text-${index}`,
    session_id: "s",
    parent_tool_use_id: null,
    event: {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "" },
    },
  } as unknown as SDKMessage;
}

function contentBlockDeltaText(index: number, text: string): SDKMessage {
  return {
    type: "stream_event",
    uuid: `env-cbd-text-${index}`,
    session_id: "s",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    },
  } as unknown as SDKMessage;
}

function contentBlockDeltaInputJson(
  index: number,
  partial: string,
): SDKMessage {
  return {
    type: "stream_event",
    uuid: `env-cbd-input-${index}`,
    session_id: "s",
    parent_tool_use_id: null,
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "input_json_delta", partial_json: partial },
    },
  } as unknown as SDKMessage;
}

function assistantEnvelope(
  toolUses: Array<{
    id: string;
    name: string;
    input: unknown;
  }>,
): SDKMessage {
  return {
    type: "assistant",
    uuid: `env-asst-${toolUses.map((t) => t.id).join(",")}`,
    session_id: "s",
    parent_tool_use_id: null,
    message: {
      id: "msg_1",
      content: toolUses.map((t) => ({
        type: "tool_use",
        id: t.id,
        name: t.name,
        input: t.input,
      })),
    },
  } as unknown as SDKMessage;
}

function userToolResult(
  toolUseId: string,
  content: unknown,
  isError = false,
): SDKMessage {
  return {
    type: "user",
    uuid: `env-user-${toolUseId}`,
    session_id: "s",
    parent_tool_use_id: null,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          is_error: isError,
        },
      ],
    },
  } as unknown as SDKMessage;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("ensureSessionLoop — text streaming", () => {
  it("appends an assistant_message on first text content_block_start, then patches with deltas", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        messageStart("msg_1"),
        contentBlockStartText(0),
        contentBlockDeltaText(0, "Hello"),
        contentBlockDeltaText(0, ", "),
        contentBlockDeltaText(0, "world"),
        messageStop(),
      ]),
    });
    expect(payloads(runtime)).toEqual([
      {
        kind: "append",
        item: { type: "assistant_message", uuid: "msg_1:0", text: "" },
      },
      { kind: "patch_text", uuid: "msg_1:0", deltaText: "Hello" },
      { kind: "patch_text", uuid: "msg_1:0", deltaText: ", " },
      { kind: "patch_text", uuid: "msg_1:0", deltaText: "world" },
    ]);
  });

  it("supports multiple text content blocks in one message (different uuids per index)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        messageStart("msg_X"),
        contentBlockStartText(0),
        contentBlockDeltaText(0, "first"),
        contentBlockStartText(1),
        contentBlockDeltaText(1, "second"),
        messageStop(),
      ]),
    });
    const out = payloads(runtime);
    const uuids = out.map((e) =>
      e.kind === "append" && e.item.type === "assistant_message"
        ? e.item.uuid
        : e.kind === "patch_text"
          ? e.uuid
          : null,
    );
    expect(uuids).toEqual(["msg_X:0", "msg_X:0", "msg_X:1", "msg_X:1"]);
  });

  it("ignores input_json_delta (V0 doesn't stream tool input partials)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        messageStart("msg_1"),
        contentBlockDeltaInputJson(0, '{"command":"ls'),
        contentBlockDeltaInputJson(0, '"}'),
        messageStop(),
      ]),
    });
    expect(payloads(runtime)).toEqual([]);
  });

  it("text_delta before message_start is ignored (no currentMessageId yet)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        contentBlockStartText(0),
        contentBlockDeltaText(0, "stray"),
      ]),
    });
    expect(payloads(runtime)).toEqual([]);
  });
});

describe("ensureSessionLoop — tool_use append", () => {
  it("appends a running tool_call with detail built from input on assistant envelope", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        assistantEnvelope([
          {
            id: "tu_1",
            name: "Bash",
            input: { command: "ls", description: "List files" },
          },
        ]),
      ]),
    });
    const out = payloads(runtime);
    expect(out).toHaveLength(1);
    const ev = out[0];
    if (ev?.kind !== "append") throw new Error("expected append");
    if (ev.item.type !== "tool_call")
      throw new Error("expected tool_call item");
    expect(ev.item.callId).toBe("tu_1");
    expect(ev.item.name).toBe("Bash");
    expect(ev.item.status).toBe("running");
    expect(ev.item.summary).toBe("List files");
    if (ev.item.detail.type !== "bash") throw new Error("expected bash detail");
    expect(ev.item.detail.command).toBe("ls");
    expect(ev.item.detail.output).toBe("");
  });

  it("does not duplicate the append if the same tool_use_id appears in two assistant envelopes", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        assistantEnvelope([
          { id: "tu_1", name: "Bash", input: { command: "ls" } },
        ]),
        assistantEnvelope([
          { id: "tu_1", name: "Bash", input: { command: "ls" } },
        ]),
      ]),
    });
    expect(payloads(runtime)).toHaveLength(1);
  });
});

describe("ensureSessionLoop — tool_result patch", () => {
  it("emits patch_tool_call (completed) with output slotted into detail.output", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        assistantEnvelope([
          { id: "tu_1", name: "Bash", input: { command: "ls" } },
        ]),
        userToolResult("tu_1", "file1\nfile2\n"),
      ]),
    });
    const out = payloads(runtime);
    expect(out).toHaveLength(2);
    const patch = out[1];
    if (patch?.kind !== "patch_tool_call") throw new Error("expected patch");
    expect(patch.callId).toBe("tu_1");
    expect(patch.status).toBe("completed");
    expect(patch.error).toBeNull();
    if (patch.detail.type !== "bash") throw new Error("expected bash detail");
    expect(patch.detail.output).toBe("file1\nfile2\n");
  });

  it("emits patch_tool_call (failed) with error text from array-form tool_result.content", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        assistantEnvelope([
          {
            id: "tu_1",
            name: "Edit",
            input: {
              file_path: "/x.ts",
              old_string: "missing",
              new_string: "x",
            },
          },
        ]),
        userToolResult(
          "tu_1",
          [{ type: "text", text: "String to replace not found in file." }],
          true,
        ),
      ]),
    });
    const out = payloads(runtime);
    const patch = out[1];
    if (patch?.kind !== "patch_tool_call") throw new Error("expected patch");
    expect(patch.status).toBe("failed");
    expect(patch.error).toBe("String to replace not found in file.");
  });

  it("drops orphan tool_results (no prior tool_use append for that id)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([userToolResult("tu_orphan", "...")]),
    });
    expect(payloads(runtime)).toEqual([]);
  });
});

describe("ensureSessionLoop — lifecycle", () => {
  it("clears runtime.query, inputChannel, loopPromise after the iterator completes", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    expect(runtime.query).toBeNull();
    expect(runtime.inputChannel).toBeNull();
    expect(runtime.loopPromise).toBeNull();
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([messageStart("msg_1"), messageStop()]),
    });
    expect(runtime.query).toBeNull();
    expect(runtime.inputChannel).toBeNull();
    expect(runtime.loopPromise).toBeNull();
  });

  it("create mode seeds settled=[] (cursor 0) so the first subscribe is race-free", async () => {
    const runtime = new SessionRuntime<EventDelta>("s-create");
    // Don't await — the seed is set synchronously, before the (empty) loop
    // drains and the finally clears settled back to null. This is the state
    // the first subscribe reads.
    const loop = ensureSessionLoop(runtime, {
      mode: "create",
      cwd: "/x",
      queryFactory: fakeQueryYielding([]),
    });
    expect(runtime.settled).toEqual([]);
    expect(runtime.settledCursor).toBe(0);
    await loop; // drain + clean up
  });

  it("resume mode does NOT seed settled (stays null → JSONL cold-path)", async () => {
    const runtime = new SessionRuntime<EventDelta>("s-resume");
    const loop = ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([]),
    });
    expect(runtime.settled).toBeNull();
    await loop;
  });

  it("iterator errors → turn_failed EventDelta + runtime state cleared", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    // Hand-rolled async iterator whose `next()` rejects — biome's `useYield`
    // would flag a `function*` body that never yields, and "yield then
    // throw" doesn't trigger the runtime's catch path the way "throw on
    // first .next()" does.
    const factory = (() => {
      const it: AsyncIterator<SDKMessage, void> & AsyncIterable<SDKMessage> = {
        [Symbol.asyncIterator]() {
          return this;
        },
        next() {
          return Promise.reject(new Error("boom"));
        },
        async return() {
          return { value: undefined, done: true };
        },
        async throw(err) {
          throw err;
        },
      };
      return Object.assign(it, {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    // No throw to caller — error surfaces as a turn_failed EventDelta in
    // the buffer (G3 replacement for F2's swallow).
    await ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    expect(payloads(runtime)).toEqual([{ kind: "turn_failed", error: "boom" }]);
    expect(runtime.query).toBeNull();
    expect(runtime.inputChannel).toBeNull();
    expect(runtime.loopPromise).toBeNull();
  });

  it("is idempotent — second call returns the existing loop promise without creating a new query", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    let queryCreations = 0;
    const factory = ((_params: unknown) => {
      queryCreations++;
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Stays open until manually drained — simulates a real long-lived query.
        yield messageStart("msg_1");
      }
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;

    const p1 = ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: factory,
    });
    const p2 = ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: factory,
    });
    expect(p1).toBe(p2);
    expect(queryCreations).toBe(1);
    await p1;
  });

  it("populates runtime.query and inputChannel synchronously before returning the promise", () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const factory = ((_params: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Empty — yields nothing.
      }
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    // Set synchronously before any microtask runs.
    expect(runtime.query).not.toBeNull();
    expect(runtime.inputChannel).not.toBeNull();
    expect(runtime.loopPromise).not.toBeNull();
  });
});

describe("pushPrompt", () => {
  it("throws if no loop is active", () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    expect(() => pushPrompt(runtime, "hi")).toThrow(/no active loop/);
  });

  it("pushes onto the active inputChannel after ensureSessionLoop", () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    const factory = ((_params: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {
        // Empty — keeps inputChannel alive synchronously.
      }
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    // Just asserting it doesn't throw — actual SDK side wiring is verified
    // by the streaming + tool tests above (which yield synthesized SDK
    // messages back through the consumer loop).
    expect(() => pushPrompt(runtime, "hi")).not.toThrow();
  });

  it("emits user_message append + turn_started synchronously, in that order", () => {
    // SDK's iterator never echoes the user prompt back — daemon synthesizes
    // the user_message append so iOS's pure event-driven render sees it
    // without needing client-side optimistic state.
    const runtime = new SessionRuntime<EventDelta>("s1");
    const factory = ((_params: unknown) => {
      async function* gen(): AsyncGenerator<SDKMessage, void> {}
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    ensureSessionLoop(runtime, { mode: "resume", queryFactory: factory });
    pushPrompt(runtime, "hi");
    // After pushPrompt: cursor=2 (user_message at 1, turn_started at 2).
    expect(runtime.currentCursor).toBe(2);
    const out = payloads(runtime);
    expect(out).toHaveLength(2);
    const first = out[0];
    if (first?.kind !== "append") throw new Error("expected append");
    if (first.item.type !== "user_message") {
      throw new Error("expected user_message item");
    }
    expect(first.item.text).toBe("hi");
    expect(typeof first.item.uuid).toBe("string");
    expect(out[1]).toEqual({ kind: "turn_started" });
  });
});

describe("ensureSessionLoop — turn lifecycle from SDK envelopes", () => {
  function resultEnvelope(
    usage?: Record<string, number | undefined>,
  ): SDKMessage {
    return {
      type: "result",
      subtype: "success",
      uuid: "env-result",
      session_id: "s",
      duration_ms: 100,
      duration_api_ms: 80,
      is_error: false,
      num_turns: 1,
      result: "ok",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      modelUsage: {},
      permission_denials: [],
      usage,
    } as unknown as SDKMessage;
  }

  it("SDK `result` envelope → turn_completed with usage parsed", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        resultEnvelope({
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 5,
        }),
      ]),
    });
    expect(payloads(runtime)).toEqual([
      {
        kind: "turn_completed",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 5,
        },
      },
    ]);
  });

  it("`result` envelope without usage → turn_completed with usage=undefined", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([resultEnvelope(undefined)]),
    });
    expect(payloads(runtime)).toEqual([
      { kind: "turn_completed", usage: undefined },
    ]);
  });

  it("`result` envelope with partial usage → only known fields populate", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        resultEnvelope({ input_tokens: 100 }), // only input_tokens
      ]),
    });
    const evts = payloads(runtime);
    expect(evts).toHaveLength(1);
    if (evts[0]?.kind !== "turn_completed")
      throw new Error("expected turn_completed");
    expect(evts[0].usage).toEqual({
      inputTokens: 100,
      outputTokens: undefined,
      cacheReadInputTokens: undefined,
      cacheCreationInputTokens: undefined,
    });
  });
});

describe("ensureSessionLoop — mode parameter passes correct option to SDK", () => {
  it("mode=create passes options.sessionId (not resume)", async () => {
    const runtime = new SessionRuntime<EventDelta>("created-uuid");
    let capturedOptions: unknown;
    const factory = ((params: unknown) => {
      capturedOptions = (params as { options?: unknown }).options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {}
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    await ensureSessionLoop(runtime, {
      mode: "create",
      cwd: "/proj",
      queryFactory: factory,
    });
    expect(capturedOptions).toMatchObject({
      sessionId: "created-uuid",
      cwd: "/proj",
      includePartialMessages: true,
    });
    expect((capturedOptions as { resume?: string }).resume).toBeUndefined();
  });

  it("mode=resume passes options.resume (not sessionId)", async () => {
    const runtime = new SessionRuntime<EventDelta>("existing-uuid");
    let capturedOptions: unknown;
    const factory = ((params: unknown) => {
      capturedOptions = (params as { options?: unknown }).options;
      async function* gen(): AsyncGenerator<SDKMessage, void> {}
      return Object.assign(gen(), {
        interrupt: vi.fn(async () => {}),
        close: vi.fn(),
      }) as unknown as Query;
    }) as typeof import("@anthropic-ai/claude-agent-sdk").query;
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: factory,
    });
    expect(capturedOptions).toMatchObject({
      resume: "existing-uuid",
      includePartialMessages: true,
    });
    expect(
      (capturedOptions as { sessionId?: string }).sessionId,
    ).toBeUndefined();
  });
});

// ─── Compact lifecycle (SDK live stream) ────────────────────────────────
// SDKStatusMessage with status='compacting' → compact_started
// SDKCompactBoundaryMessage → compact_applied (+ primes summary lift)
// Following SDKUserMessage → compact_summary append (sequence-detected)

function statusMsg(status: "compacting" | "requesting" | null): SDKMessage {
  return {
    type: "system",
    subtype: "status",
    uuid: `env-status-${status ?? "null"}`,
    session_id: "s",
    status,
  } as unknown as SDKMessage;
}

function compactBoundaryEnvelope(
  uuid: string,
  meta: {
    trigger: "manual" | "auto";
    pre_tokens: number;
    post_tokens: number;
    duration_ms?: number;
    preserved_messages?: { anchor_uuid: string; uuids: string[] };
  },
): SDKMessage {
  return {
    type: "system",
    subtype: "compact_boundary",
    uuid,
    session_id: "s",
    compact_metadata: meta,
  } as unknown as SDKMessage;
}

function plainUserEnvelope(uuid: string, text: string): SDKMessage {
  return {
    type: "user",
    uuid,
    session_id: "s",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  } as unknown as SDKMessage;
}

describe("ensureSessionLoop — compact lifecycle", () => {
  it("SDKStatusMessage status='compacting' → compact_started", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([statusMsg("compacting")]),
    });
    expect(payloads(runtime)).toEqual([{ kind: "compact_started" }]);
  });

  it("status='requesting' and status=null are ignored (UI noise)", async () => {
    // Only 'compacting' is a UI-relevant signal. 'requesting' fires for
    // every API call and would spam the UI; null is resting state.
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([statusMsg("requesting"), statusMsg(null)]),
    });
    expect(payloads(runtime)).toEqual([]);
  });

  it("compact_boundary → compact_applied with metadata fields mapped", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        compactBoundaryEnvelope("b-1", {
          trigger: "manual",
          pre_tokens: 34000,
          post_tokens: 4000,
          duration_ms: 37000,
        }),
      ]),
    });
    expect(payloads(runtime)).toEqual([
      {
        kind: "compact_applied",
        trigger: "manual",
        preTokens: 34000,
        postTokens: 4000,
        durationMs: 37000,
        uuid: "b-1",
      },
    ]);
  });

  it("compact_boundary with preserved_messages → preservedUuids forwarded", async () => {
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        compactBoundaryEnvelope("b-1", {
          trigger: "auto",
          pre_tokens: 180000,
          post_tokens: 18000,
          preserved_messages: {
            anchor_uuid: "anchor-1",
            uuids: ["keep-1", "keep-2", "keep-3"],
          },
        }),
      ]),
    });
    const ev = payloads(runtime)[0];
    if (ev?.kind !== "compact_applied")
      throw new Error("expected compact_applied");
    expect(ev.preservedUuids).toEqual(["keep-1", "keep-2", "keep-3"]);
  });

  it("compact_boundary without preserved_messages → preservedUuids omitted (full compact)", async () => {
    // The 99% case — manual /compact and auto-compact both go full.
    // iOS reducer treats undefined as "drop everything pre-compact".
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        compactBoundaryEnvelope("b-1", {
          trigger: "manual",
          pre_tokens: 34000,
          post_tokens: 4000,
        }),
      ]),
    });
    const ev = payloads(runtime)[0];
    if (ev?.kind !== "compact_applied")
      throw new Error("expected compact_applied");
    expect(ev.preservedUuids).toBeUndefined();
  });

  it("the user message immediately following compact_boundary → user_message append (summary lift)", async () => {
    // SDK live type doesn't expose isCompactSummary, so we detect by
    // sequence: the first user msg after a compact_boundary is the
    // SDK-injected summary. Lifted to a regular user_message append so
    // iOS renders it (without the lift it'd be dropped — handleUserEnvelope
    // only processes tool_result blocks on plain text user msgs). Verifies
    // the expectingCompactSummary flag is set + consumed correctly.
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        compactBoundaryEnvelope("b-1", {
          trigger: "manual",
          pre_tokens: 34000,
          post_tokens: 4000,
        }),
        plainUserEnvelope("s-1", "Summary covering earlier conversation..."),
      ]),
    });
    const evts = payloads(runtime);
    expect(evts).toEqual([
      {
        kind: "compact_applied",
        trigger: "manual",
        preTokens: 34000,
        postTokens: 4000,
        uuid: "b-1",
      },
      {
        kind: "append",
        item: {
          type: "user_message",
          uuid: "s-1",
          text: "Summary covering earlier conversation...",
        },
      },
    ]);
  });

  it("subsequent user msgs after the summary are NOT lifted", async () => {
    // Flag clears on first consume — only ONE summary per boundary.
    // Later user messages flow through the normal tool_result path
    // (which no-ops on plain text user msgs, preventing duplicate
    // rendering of iOS-typed prompts).
    const runtime = new SessionRuntime<EventDelta>("s1");
    await ensureSessionLoop(runtime, {
      mode: "resume",
      queryFactory: fakeQueryYielding([
        compactBoundaryEnvelope("b-1", {
          trigger: "manual",
          pre_tokens: 34000,
          post_tokens: 4000,
        }),
        plainUserEnvelope("s-1", "Summary text"),
        plainUserEnvelope("u-2", "user's next prompt"),
      ]),
    });
    const evts = payloads(runtime);
    // Expect: compact_applied + ONE user_message append (the lifted
    // summary), but NOT a second append for u-2.
    expect(evts.filter((e) => e.kind === "append")).toHaveLength(1);
  });
});
