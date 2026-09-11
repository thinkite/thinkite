/**
 * Fixture-driven tests for the transcript reducer. Fixtures are the real
 * 1.18.30 logs recorded in stage 1 (copied from
 * `packages/daemon/src/opencode/__fixtures__/`); `compaction-turn.json`
 * stays synthetic (manual compact is 503 in this version — see the stage-1
 * report), as are the inline revert/permission/question events below.
 */

import { describe, expect, it } from "vitest";
import bashReadTurn from "./__fixtures__/bash-read-turn.json" with {
  type: "json",
};
import compactionTurn from "./__fixtures__/compaction-turn.json" with {
  type: "json",
};
import interruptedTurn from "./__fixtures__/interrupted-turn.json" with {
  type: "json",
};
import textDeltas from "./__fixtures__/text-deltas.json" with { type: "json" };
import textTurn from "./__fixtures__/text-turn.json" with { type: "json" };
import toolsTurn from "./__fixtures__/tools-turn.json" with { type: "json" };
import {
  applyOcEvent,
  createInitialTranscriptState,
  foldOcEvents,
  type OcEventLike,
  type OcRow,
  type OcTranscriptState,
} from "./reducer.ts";

const FIXTURE_MAP: Record<string, OcEventLike[]> = {
  "bash-read-turn.json": bashReadTurn as OcEventLike[],
  "compaction-turn.json": compactionTurn as OcEventLike[],
  "interrupted-turn.json": interruptedTurn as OcEventLike[],
  "text-deltas.json": textDeltas as OcEventLike[],
  "text-turn.json": textTurn as OcEventLike[],
  "tools-turn.json": toolsTurn as OcEventLike[],
};

function load(name: string): OcEventLike[] {
  const events = FIXTURE_MAP[name];
  if (events === undefined) throw new Error(`unknown fixture: ${name}`);
  return events;
}

function rowsOf(state: OcTranscriptState): OcRow[] {
  return state.rows;
}

describe("oc transcript reducer", () => {
  it("folds a plain text turn (user + final assistant text + usage)", () => {
    const state = foldOcEvents(load("text-turn.json"));
    const rows = rowsOf(state);
    expect(rows.filter((r) => r.kind === "user")).toHaveLength(1);
    expect(rows.find((r) => r.kind === "user")).toMatchObject({
      text: "Reply with exactly the word pong and nothing else.",
    });
    const texts = rows.filter((r) => r.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: "pong", streaming: false });
    expect(state.usage).toMatchObject({ inputTokens: 2930, outputTokens: 3 });
    expect(state.lastSeq).toBe(6);
  });

  it("pairs bash+edit+read calls with typed details and outputs", () => {
    const state = foldOcEvents(load("tools-turn.json"));
    const tools = rowsOf(state).filter((r) => r.kind === "tool");
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => (t.kind === "tool" ? t.name : ""))).toEqual([
      "read",
      "edit",
      "read",
      "bash",
    ]);
    for (const tool of tools) {
      expect(tool.kind === "tool" && tool.status).toBe("completed");
      expect(tool.kind === "tool" && tool.error).toBeNull();
    }
    const read = tools[0];
    expect(read.kind === "tool" && read.detail).toMatchObject({
      tool: "read",
      path: "notes.txt",
    });
    // Read success text rides `structured.content` (empty content[]).
    expect(read.kind === "tool" && read.output).toContain("line one");
    const edit = tools[1];
    expect(edit.kind === "tool" && edit.detail).toMatchObject({
      tool: "edit",
      path: "notes.txt",
      oldString: "line two",
      newString: "line two edited",
    });
    // Edit output keeps the diff text.
    expect(edit.kind === "tool" && edit.output).toContain("-line two");
    const bash = tools[3];
    expect(bash.kind === "tool" && bash.detail).toEqual({
      tool: "bash",
      command: "cat notes.txt",
    });
    expect(bash.kind === "tool" && bash.summary).toBe("cat notes.txt");
  });

  it("marks a failed tool with its error text", () => {
    const state = foldOcEvents(load("bash-read-turn.json"));
    const tools = rowsOf(state).filter((r) => r.kind === "tool");
    expect(tools).toHaveLength(2);
    const [bash, read] = tools;
    expect(bash?.kind === "tool" && bash.status).toBe("completed");
    expect(read?.kind === "tool" && read.status).toBe("error");
    expect(read?.kind === "tool" && read.error).toContain(
      "Unable to read package.json",
    );
    // Reasoning blocks fold into reasoning rows (final, not streaming).
    const reasoning = rowsOf(state).filter((r) => r.kind === "reasoning");
    expect(reasoning.length).toBeGreaterThan(0);
    for (const row of reasoning) {
      expect(row.kind === "reasoning" && row.streaming).toBe(false);
      expect(row.kind === "reasoning" && row.text.length).toBeGreaterThan(0);
    }
  });

  it("emits a step-failed row for an interrupted turn", () => {
    const state = foldOcEvents(load("interrupted-turn.json"));
    const failed = rowsOf(state).filter((r) => r.kind === "step-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ error: "Provider turn interrupted" });
    // The partial text still lands (authoritative ended event).
    const texts = rowsOf(state).filter((r) => r.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]?.kind === "text" && texts[0].text).toContain("Pell");
  });

  it("reconciles live deltas with the authoritative text.ended", () => {
    // text-deltas.json holds the live-only bus fragment sequence
    // (started → delta → delta → ended); replaying it must equal the
    // durable text.
    let state = createInitialTranscriptState();
    for (const event of load("text-deltas.json")) {
      state = applyOcEvent(state, event);
    }
    const texts = rowsOf(state).filter((r) => r.kind === "text");
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatchObject({ text: "pong", streaming: false });

    // Missed deltas entirely: ended alone still yields the full text.
    let cold = createInitialTranscriptState();
    const events = load("text-turn.json");
    const ended = events.find((e) => e.type === "session.next.text.ended");
    expect(ended).toBeDefined();
    cold = applyOcEvent(cold, ended!);
    const coldTexts = rowsOf(cold).filter((r) => r.kind === "text");
    expect(coldTexts).toHaveLength(1);
    expect(coldTexts[0]).toMatchObject({ text: "pong", streaming: false });
  });

  it("dedupes by seq across out-of-order and duplicate delivery", () => {
    const events = load("text-turn.json");
    const shuffled = [...events].reverse();
    const doubled = [...shuffled, ...events];
    const state = foldOcEvents(doubled);
    const baseline = foldOcEvents(events);
    // Converged content is identical (row insertion order follows arrival
    // order, so a reversed replay orders rows differently — compare
    // order-insensitively).
    const byId = (rows: OcRow[]) =>
      [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(byId(rowsOf(state))).toEqual(byId(rowsOf(baseline)));
    expect(state.usage).toEqual(baseline.usage);
    expect(state.lastSeq).toBe(6);
  });

  it("folds the synthetic compaction fixture into a marker row", () => {
    // SYNTHETIC fixture (see stage-1 report): compact is 503 live.
    const state = foldOcEvents(load("compaction-turn.json"));
    const markers = rowsOf(state).filter((r) => r.kind === "compaction");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      reason: "manual",
      streaming: false,
    });
    // The post-compaction turn still streams after the marker.
    const markerIdx = rowsOf(state).findIndex((r) => r.kind === "compaction");
    const after = rowsOf(state).slice(markerIdx + 1);
    expect(after.some((r) => r.kind === "text")).toBe(true);
  });

  it("tracks busy/idle from session.status (retry counts as busy)", () => {
    let state = createInitialTranscriptState();
    expect(state.status).toBe("idle");
    state = applyOcEvent(state, {
      type: "session.status",
      data: { sessionID: "ses_x", status: { type: "busy" } },
    });
    expect(state.status).toBe("busy");
    state = applyOcEvent(state, {
      type: "session.status",
      data: { sessionID: "ses_x", status: { type: "retry", attempt: 1 } },
    });
    expect(state.status).toBe("busy");
    state = applyOcEvent(state, {
      type: "session.status",
      data: { sessionID: "ses_x", status: { type: "idle" } },
    });
    expect(state.status).toBe("idle");
    // Deprecated session.idle still idles (older servers).
    state = applyOcEvent(state, {
      type: "session.status",
      data: { sessionID: "ses_x", status: { type: "busy" } },
    });
    state = applyOcEvent(state, {
      type: "session.idle",
      data: { sessionID: "ses_x" },
    });
    expect(state.status).toBe("idle");
  });

  it("drives busy/idle off step boundaries (the 1.18.30 v2 engine emits no session.status)", () => {
    let state = createInitialTranscriptState();
    // Admission means the server will run the turn.
    state = applyOcEvent(state, {
      type: "session.next.prompt.admitted",
      data: { sessionID: "ses_x", messageID: "msg_1", prompt: { text: "hi" } },
    });
    expect(state.status).toBe("busy");
    // Mid-turn step end (finish tool-calls) stays busy…
    state = applyOcEvent(state, {
      type: "session.next.step.ended",
      durable: { seq: 10 },
      data: {
        sessionID: "ses_x",
        assistantMessageID: "a",
        finish: "tool-calls",
      },
    });
    expect(state.status).toBe("busy");
    state = applyOcEvent(state, {
      type: "session.next.step.started",
      durable: { seq: 11 },
      data: { sessionID: "ses_x", assistantMessageID: "b" },
    });
    expect(state.status).toBe("busy");
    // …terminal finish idles.
    state = applyOcEvent(state, {
      type: "session.next.step.ended",
      durable: { seq: 12 },
      data: { sessionID: "ses_x", assistantMessageID: "b", finish: "stop" },
    });
    expect(state.status).toBe("idle");
    // Failure idles too.
    state = applyOcEvent(state, {
      type: "session.next.step.started",
      durable: { seq: 13 },
      data: { sessionID: "ses_x", assistantMessageID: "c" },
    });
    state = applyOcEvent(state, {
      type: "session.next.step.failed",
      durable: { seq: 14 },
      data: { sessionID: "ses_x", assistantMessageID: "c", error: {} },
    });
    expect(state.status).toBe("idle");
  });

  it("collects pending permission/question asks and clears on reply", () => {
    // SYNTHETIC bus events (no ask fired in any live run — stage-1 report).
    let state = createInitialTranscriptState();
    state = applyOcEvent(state, {
      type: "permission.v2.asked",
      data: {
        id: "perm_1",
        sessionID: "ses_x",
        action: "edit",
        resources: ["notes.txt"],
      },
    });
    state = applyOcEvent(state, {
      type: "question.v2.asked",
      data: {
        id: "q_1",
        sessionID: "ses_x",
        questions: [
          {
            question: "Which one?",
            header: "Pick",
            options: [{ label: "A", description: "first" }],
          },
        ],
      },
    });
    expect(state.permissions).toHaveLength(1);
    expect(state.questions).toHaveLength(1);
    expect(state.rows).toHaveLength(0);
    state = applyOcEvent(state, {
      type: "permission.v2.replied",
      data: { sessionID: "ses_x", requestID: "perm_1", reply: "once" },
    });
    state = applyOcEvent(state, {
      type: "question.v2.rejected",
      data: { sessionID: "ses_x", requestID: "q_1" },
    });
    expect(state.permissions).toHaveLength(0);
    expect(state.questions).toHaveLength(0);
  });

  it("drops stale deltas redelivered after the authoritative ended", () => {
    // The bus replays its bounded buffer to every new subscriber, so
    // deltas can arrive after their `*.ended` (observed live: "pongpong").
    let state = createInitialTranscriptState();
    const base = {
      sessionID: "ses_x",
      assistantMessageID: "assistant_1",
    };
    state = applyOcEvent(state, {
      type: "session.next.text.started",
      data: { ...base, textID: "text-0" },
    });
    state = applyOcEvent(state, {
      type: "session.next.text.delta",
      data: { ...base, textID: "text-0", delta: "pong" },
    });
    state = applyOcEvent(state, {
      type: "session.next.text.ended",
      data: { ...base, textID: "text-0", text: "pong" },
    });
    const finalized = state;
    expect(finalized.rows.find((r) => r.kind === "text")).toMatchObject({
      text: "pong",
      streaming: false,
    });
    // Redelivered deltas change nothing (same state object back).
    state = applyOcEvent(state, {
      type: "session.next.text.delta",
      data: { ...base, textID: "text-0", delta: "pong" },
    });
    expect(state).toBe(finalized);

    // Reasoning: same gate.
    state = applyOcEvent(state, {
      type: "session.next.reasoning.started",
      data: { ...base, reasoningID: "reasoning-0" },
    });
    state = applyOcEvent(state, {
      type: "session.next.reasoning.ended",
      data: { ...base, reasoningID: "reasoning-0", text: "thinking" },
    });
    const reasoned = state;
    state = applyOcEvent(state, {
      type: "session.next.reasoning.delta",
      data: { ...base, reasoningID: "reasoning-0", delta: "thinking" },
    });
    expect(state).toBe(reasoned);

    // Tool input deltas after the result are dropped, as are deltas for
    // a call with no row yet (missed `input.started`).
    state = applyOcEvent(state, {
      type: "session.next.tool.called",
      data: {
        ...base,
        callID: "call_1",
        tool: "bash",
        input: { command: "echo hi" },
      },
    });
    state = applyOcEvent(state, {
      type: "session.next.tool.success",
      data: {
        ...base,
        callID: "call_1",
        content: [{ type: "text", text: "hi" }],
      },
    });
    const settled = state;
    state = applyOcEvent(state, {
      type: "session.next.tool.input.delta",
      data: { ...base, callID: "call_1", delta: "echo hi" },
    });
    expect(state).toBe(settled);
    state = applyOcEvent(state, {
      type: "session.next.tool.input.delta",
      data: { ...base, callID: "call_unknown", delta: "x" },
    });
    expect(state).toBe(settled);
  });

  it("keeps usage from the terminal step.ended", () => {
    const state = foldOcEvents(load("tools-turn.json"));
    expect(state.usage?.inputTokens).toBeGreaterThan(0);
    expect(state.usage?.outputTokens).toBeGreaterThan(0);
  });

  it("replaces the revert marker in its single slot", () => {
    // SYNTHETIC (no revert fixture recorded in stage 1).
    let state = createInitialTranscriptState();
    state = applyOcEvent(state, {
      type: "session.next.revert.staged",
      durable: { seq: 10 },
      data: { sessionID: "ses_x", revert: { messageID: "msg_1" } },
    });
    expect(rowsOf(state).filter((r) => r.kind === "revert")).toHaveLength(1);
    state = applyOcEvent(state, {
      type: "session.next.revert.committed",
      durable: { seq: 11 },
      data: { sessionID: "ses_x", messageID: "msg_1" },
    });
    const markers = rowsOf(state).filter((r) => r.kind === "revert");
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ state: "committed" });
  });

  it("ignores unrelated bus events without touching state", () => {
    const state = createInitialTranscriptState();
    const next = applyOcEvent(state, {
      type: "session.created",
      data: { sessionID: "ses_x", info: {} },
    });
    expect(next).toBe(state);
  });
});
