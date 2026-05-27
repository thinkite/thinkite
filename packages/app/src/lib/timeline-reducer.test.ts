import type { EventDelta, TimelineItem } from "@sidecodeapp/protocol";
import { describe, expect, it } from "vitest";
import {
  applyDelta,
  applySettled,
  emptyTimelineState,
  type TimelineState,
} from "./timeline-reducer";

// ─── fixtures ─────────────────────────────────────────────────────────────

function userMsg(uuid: string, text: string): TimelineItem {
  return { type: "user_message", uuid, text };
}

function assistantMsg(uuid: string, text: string): TimelineItem {
  return { type: "assistant_message", uuid, text };
}

function bashTool(
  callId: string,
  summary: string,
  output = "",
  status: "completed" | "failed" | "running" = "running",
  error: string | null = null,
): TimelineItem {
  return {
    type: "tool_call",
    callId,
    name: "Bash",
    summary,
    status,
    error,
    detail: { type: "bash", command: "ls", output },
  };
}

// ─── basic constructors ───────────────────────────────────────────────────

describe("emptyTimelineState", () => {
  it("returns isolated empty state", () => {
    const a = emptyTimelineState();
    const b = emptyTimelineState();
    expect(a).toEqual({
      items: [],
      cursor: 0,
      isRunning: false,
      lastError: null,
      latestUsage: null,
    });
    expect(a).not.toBe(b);
    expect(a.items).not.toBe(b.items);
  });
});

describe("applySettled", () => {
  it("clones the settled array (so caller mutations don't leak)", () => {
    const settled = [userMsg("u1", "hello")];
    const state = applySettled(settled, 5);
    expect(state.items).toEqual(settled);
    expect(state.items).not.toBe(settled);
    expect(state.cursor).toBe(5);
    expect(state.isRunning).toBe(false);
    expect(state.lastError).toBe(null);
  });

  it("starts isRunning false even if prior turn was in flight", () => {
    // Subscribe-time settled snapshot reflects JSONL — never carries
    // live turn state. iOS will see the next turn_started delta if
    // a turn is genuinely active.
    const state = applySettled([assistantMsg("a1", "...")], 99);
    expect(state.isRunning).toBe(false);
  });

  it("starts latestUsage null when no initialUsage is supplied", () => {
    // Fresh session, or a resumed session whose last assistant turn
    // was tool-only (no API usage stamp on the envelope).
    const state = applySettled([assistantMsg("a1", "hi")], 42);
    expect(state.latestUsage).toBe(null);
  });

  it("seeds latestUsage from initialUsage when supplied", () => {
    // Resume path — daemon extracted usage from the JSONL's last
    // assistant message (subscribe.response.initialUsage) so the
    // context meter renders immediately rather than waiting for the
    // next live turn_completed. Verifies the seed is passed through
    // verbatim.
    const state = applySettled([assistantMsg("a1", "hi")], 42, {
      inputTokens: 500,
      cacheReadInputTokens: 120_000,
      cacheCreationInputTokens: 2_000,
    });
    expect(state.latestUsage).toEqual({
      inputTokens: 500,
      cacheReadInputTokens: 120_000,
      cacheCreationInputTokens: 2_000,
    });
  });
});

// ─── append ───────────────────────────────────────────────────────────────

describe("applyDelta — append", () => {
  it("appends user_message", () => {
    const before = emptyTimelineState();
    const delta: EventDelta = { kind: "append", item: userMsg("u1", "hi") };
    const after = applyDelta(before, delta, 1);
    expect(after.items).toEqual([userMsg("u1", "hi")]);
    expect(after.cursor).toBe(1);
    // Original state unchanged (immutability invariant)
    expect(before.items).toEqual([]);
    expect(before.cursor).toBe(0);
  });

  it("appends assistant_message and tool_call in order", () => {
    let state = emptyTimelineState();
    state = applyDelta(
      state,
      { kind: "append", item: userMsg("u1", "do it") },
      1,
    );
    state = applyDelta(
      state,
      { kind: "append", item: assistantMsg("a1", "") },
      2,
    );
    state = applyDelta(
      state,
      { kind: "append", item: bashTool("t1", "ls") },
      3,
    );
    expect(state.items.map((i) => i.type)).toEqual([
      "user_message",
      "assistant_message",
      "tool_call",
    ]);
    expect(state.cursor).toBe(3);
  });
});

// ─── patch_text ───────────────────────────────────────────────────────────

describe("applyDelta — patch_text", () => {
  it("appends deltaText to the matching assistant_message", () => {
    const init = applySettled([assistantMsg("a1", "Hel")], 1);
    const after = applyDelta(
      init,
      { kind: "patch_text", uuid: "a1", deltaText: "lo" },
      2,
    );
    expect(after.items[0]).toEqual(assistantMsg("a1", "Hello"));
    expect(after.cursor).toBe(2);
  });

  it("accumulates multiple chunks into the same item", () => {
    let state = applySettled([assistantMsg("a1", "")], 0);
    for (const chunk of ["Once ", "upon ", "a ", "time."]) {
      state = applyDelta(
        state,
        { kind: "patch_text", uuid: "a1", deltaText: chunk },
        state.cursor + 1,
      );
    }
    expect((state.items[0] as { text: string }).text).toBe("Once upon a time.");
    expect(state.cursor).toBe(4);
  });

  it("ignores user_messages even with matching uuid (defensive)", () => {
    // user_message + assistant_message can't actually share uuid in
    // practice, but the reducer is documented to only match
    // assistant_message — verify.
    const init = applySettled([userMsg("shared", "hi")], 1);
    const after = applyDelta(
      init,
      { kind: "patch_text", uuid: "shared", deltaText: " (mutated?)" },
      2,
    );
    expect(after.items[0]).toEqual(userMsg("shared", "hi"));
  });

  it("no-ops on missing uuid", () => {
    const init = applySettled([assistantMsg("a1", "stable")], 1);
    const after = applyDelta(
      init,
      { kind: "patch_text", uuid: "ghost", deltaText: " ?" },
      2,
    );
    expect(after.items).toEqual(init.items);
    expect(after.cursor).toBe(2);
  });

  it("only mutates the matching item among many", () => {
    const init = applySettled(
      [assistantMsg("a1", "one"), assistantMsg("a2", "two")],
      0,
    );
    const after = applyDelta(
      init,
      { kind: "patch_text", uuid: "a2", deltaText: "X" },
      1,
    );
    expect(after.items[0]).toEqual(assistantMsg("a1", "one"));
    expect(after.items[1]).toEqual(assistantMsg("a2", "twoX"));
  });
});

// ─── patch_tool_call ──────────────────────────────────────────────────────

describe("applyDelta — patch_tool_call", () => {
  it("flips running → completed and replaces detail", () => {
    const init = applySettled([bashTool("t1", "ls", "", "running", null)], 0);
    const after = applyDelta(
      init,
      {
        kind: "patch_tool_call",
        callId: "t1",
        status: "completed",
        error: null,
        detail: { type: "bash", command: "ls", output: "a.txt\nb.txt" },
      },
      1,
    );
    expect(after.items[0]).toEqual({
      type: "tool_call",
      callId: "t1",
      name: "Bash",
      summary: "ls",
      status: "completed",
      error: null,
      detail: { type: "bash", command: "ls", output: "a.txt\nb.txt" },
    });
  });

  it("flips running → failed with error text", () => {
    const init = applySettled([bashTool("t1", "ls", "", "running", null)], 0);
    const after = applyDelta(
      init,
      {
        kind: "patch_tool_call",
        callId: "t1",
        status: "failed",
        error: "exit 1",
        detail: {
          type: "bash",
          command: "ls",
          output: "Permission denied",
        },
      },
      1,
    );
    const item = after.items[0] as Extract<TimelineItem, { type: "tool_call" }>;
    expect(item.status).toBe("failed");
    expect(item.error).toBe("exit 1");
  });

  it("no-ops on missing callId", () => {
    const init = applySettled([bashTool("t1", "ls", "", "running", null)], 0);
    const after = applyDelta(
      init,
      {
        kind: "patch_tool_call",
        callId: "ghost",
        status: "completed",
        error: null,
        detail: { type: "bash", command: "ls", output: "" },
      },
      1,
    );
    expect(after.items).toEqual(init.items);
  });

  it("ignores user/assistant items with same callId (type-safe)", () => {
    // Defensive: only items with type:"tool_call" are touched. Even if
    // a user_message somehow had a property colliding with callId,
    // the discriminator guards.
    const init = applySettled(
      [userMsg("u1", "hi"), bashTool("t1", "ls", "", "running", null)],
      0,
    );
    const after = applyDelta(
      init,
      {
        kind: "patch_tool_call",
        callId: "t1",
        status: "completed",
        error: null,
        detail: { type: "bash", command: "ls", output: "ok" },
      },
      1,
    );
    expect(after.items[0]).toEqual(userMsg("u1", "hi"));
    const item = after.items[1] as Extract<TimelineItem, { type: "tool_call" }>;
    expect(item.status).toBe("completed");
  });
});

// ─── turn lifecycle ───────────────────────────────────────────────────────

describe("applyDelta — turn lifecycle", () => {
  it("turn_started sets isRunning true and clears prior lastError", () => {
    const init: TimelineState = {
      ...emptyTimelineState(),
      lastError: "prior failure",
    };
    const after = applyDelta(init, { kind: "turn_started" }, 1);
    expect(after.isRunning).toBe(true);
    expect(after.lastError).toBe(null);
    expect(after.cursor).toBe(1);
  });

  it("turn_completed sets isRunning false; lastError preserved", () => {
    const running: TimelineState = {
      ...emptyTimelineState(),
      isRunning: true,
      lastError: null,
    };
    const after = applyDelta(
      running,
      {
        kind: "turn_completed",
        usage: { inputTokens: 10, outputTokens: 20 },
      },
      9,
    );
    expect(after.isRunning).toBe(false);
    expect(after.lastError).toBe(null);
    expect(after.cursor).toBe(9);
  });

  it("turn_completed writes through `usage` payload to latestUsage", () => {
    // Meter consumer (useContextUsage) reads this. Snapshot replaces
    // prior — SDK's per-turn usage is cumulative (cache_read covers
    // full prior context), not delta.
    const init = emptyTimelineState();
    const after = applyDelta(
      init,
      {
        kind: "turn_completed",
        usage: {
          inputTokens: 100,
          outputTokens: 50,
          cacheReadInputTokens: 80_000,
          cacheCreationInputTokens: 2_000,
        },
      },
      1,
    );
    expect(after.latestUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadInputTokens: 80_000,
      cacheCreationInputTokens: 2_000,
    });
  });

  it("turn_completed without `usage` preserves prior latestUsage", () => {
    // Defensive: protocol marks usage optional on the delta. Don't
    // drop the meter back to null just because one turn's envelope
    // lacked the field — better to keep slightly-stale than blank.
    const prior: TimelineState = {
      ...emptyTimelineState(),
      latestUsage: { inputTokens: 5_000 },
    };
    const after = applyDelta(prior, { kind: "turn_completed" }, 2);
    expect(after.latestUsage).toEqual({ inputTokens: 5_000 });
  });

  it("turn_completed overwrites a prior latestUsage with the newer one", () => {
    const prior: TimelineState = {
      ...emptyTimelineState(),
      latestUsage: { inputTokens: 1_000 },
    };
    const after = applyDelta(
      prior,
      { kind: "turn_completed", usage: { inputTokens: 9_999 } },
      3,
    );
    expect(after.latestUsage).toEqual({ inputTokens: 9_999 });
  });

  it("turn_failed sets isRunning false + records error", () => {
    const running: TimelineState = {
      ...emptyTimelineState(),
      isRunning: true,
    };
    const after = applyDelta(
      running,
      { kind: "turn_failed", error: "rate-limited" },
      9,
    );
    expect(after.isRunning).toBe(false);
    expect(after.lastError).toBe("rate-limited");
  });

  it("turn_canceled sets isRunning false (no error recorded)", () => {
    const running: TimelineState = {
      ...emptyTimelineState(),
      isRunning: true,
    };
    const after = applyDelta(running, { kind: "turn_canceled" }, 9);
    expect(after.isRunning).toBe(false);
    expect(after.lastError).toBe(null);
  });

  it("turn_started clears a prior turn_failed's error", () => {
    let state: TimelineState = emptyTimelineState();
    state = applyDelta(state, { kind: "turn_failed", error: "boom" }, 1);
    expect(state.lastError).toBe("boom");
    state = applyDelta(state, { kind: "turn_started" }, 2);
    expect(state.lastError).toBe(null);
    expect(state.isRunning).toBe(true);
  });
});

// ─── end-to-end sequence ──────────────────────────────────────────────────

describe("applyDelta — realistic turn sequence", () => {
  it("user → turn_started → assistant + patch_text → tool running → tool completed → turn_completed", () => {
    let s: TimelineState = emptyTimelineState();
    let c = 0;
    const step = (d: EventDelta): void => {
      c += 1;
      s = applyDelta(s, d, c);
    };

    step({ kind: "append", item: userMsg("u1", "list files") });
    step({ kind: "turn_started" });
    expect(s.isRunning).toBe(true);

    step({ kind: "append", item: assistantMsg("a1", "") });
    step({ kind: "patch_text", uuid: "a1", deltaText: "Sure," });
    step({ kind: "patch_text", uuid: "a1", deltaText: " let me check." });

    step({
      kind: "append",
      item: bashTool("t1", "ls", "", "running", null),
    });
    step({
      kind: "patch_tool_call",
      callId: "t1",
      status: "completed",
      error: null,
      detail: { type: "bash", command: "ls", output: "a.txt\nb.txt" },
    });

    step({
      kind: "turn_completed",
      usage: { inputTokens: 10, outputTokens: 20 },
    });

    expect(s.isRunning).toBe(false);
    expect(s.lastError).toBe(null);
    expect(s.cursor).toBe(c);
    expect(s.items).toHaveLength(3);
    expect((s.items[1] as { text: string }).text).toBe("Sure, let me check.");
    const tool = s.items[2] as Extract<TimelineItem, { type: "tool_call" }>;
    expect(tool.status).toBe("completed");
    expect(
      (tool.detail as Extract<typeof tool.detail, { type: "bash" }>).output,
    ).toBe("a.txt\nb.txt");
  });

  it("interrupt: user → turn_started → partial assistant → turn_canceled", () => {
    let s = emptyTimelineState();
    let c = 0;
    const step = (d: EventDelta): void => {
      c += 1;
      s = applyDelta(s, d, c);
    };

    step({ kind: "append", item: userMsg("u1", "long task") });
    step({ kind: "turn_started" });
    step({ kind: "append", item: assistantMsg("a1", "") });
    step({ kind: "patch_text", uuid: "a1", deltaText: "Working" });
    step({ kind: "turn_canceled" });

    expect(s.isRunning).toBe(false);
    expect((s.items[1] as { text: string }).text).toBe("Working");
  });
});

// ─── immutability ─────────────────────────────────────────────────────────

describe("applyDelta — immutability", () => {
  it("never mutates the input state", () => {
    const init = applySettled(
      [userMsg("u1", "hi"), assistantMsg("a1", "ho"), bashTool("t1", "ls", "")],
      0,
    );
    const snapshotItems = [...init.items];
    const snapshotCursor = init.cursor;
    const snapshotIsRunning = init.isRunning;

    applyDelta(init, { kind: "patch_text", uuid: "a1", deltaText: "X" }, 1);
    applyDelta(
      init,
      {
        kind: "patch_tool_call",
        callId: "t1",
        status: "completed",
        error: null,
        detail: { type: "bash", command: "ls", output: "" },
      },
      2,
    );
    applyDelta(init, { kind: "turn_started" }, 3);
    applyDelta(init, { kind: "append", item: userMsg("u2", "another") }, 4);

    expect(init.items).toEqual(snapshotItems);
    expect(init.cursor).toBe(snapshotCursor);
    expect(init.isRunning).toBe(snapshotIsRunning);
  });

  it("returns a new items array reference even when no item matches", () => {
    // patch_text on missing uuid still bumps cursor; spec is "always
    // return new state" so React sees the change.
    const init = applySettled([assistantMsg("a1", "x")], 0);
    const after = applyDelta(
      init,
      { kind: "patch_text", uuid: "missing", deltaText: "z" },
      1,
    );
    expect(after).not.toBe(init);
    expect(after.cursor).toBe(1);
  });
});
