/**
 * Fixture-driven tests for the opencode event mapping. Fixtures are real
 * durable logs recorded from `opencode serve` 1.18.30 (see
 * `scripts/record-opencode-fixtures.ts`), except `compaction-turn.json`
 * which is synthetic — manual compact is 503 in this version.
 */

import { readFileSync } from "node:fs";
import type { EventDelta, TimelineItem } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import type { OpencodeDurableEvent } from "./client.ts";
import {
  buildOpencodeDetail,
  createOpencodeLiveState,
  mapOpencodeLiveEvent,
  normalizeOpencodeHistory,
  opencodeTurnUsage,
} from "./normalize-opencode.ts";

function fixture(name: string): OpencodeDurableEvent[] {
  const raw = readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url));
  return JSON.parse(raw.toString()) as OpencodeDurableEvent[];
}

function toolCalls(items: TimelineItem[]) {
  return items.filter((i) => i.type === "tool_call");
}

describe("normalizeOpencodeHistory", () => {
  it("maps a plain text turn (user + assistant, usage)", () => {
    const { items, usage } = normalizeOpencodeHistory(
      fixture("text-turn.json"),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "user_message" });
    expect(items[1]).toMatchObject({ type: "assistant_message", text: "pong" });
    // admitted + prompted share one messageID → single user_message.
    if (
      items[0]?.type === "user_message" &&
      items[1]?.type === "assistant_message"
    ) {
      expect(items[0].uuid).toBeDefined();
      // Live + cold paths share the `${assistantMessageID}:${textID}` scheme.
      expect(items[1].uuid).toContain(":");
    } else {
      expect.unreachable("expected user + assistant messages");
    }
    expect(usage?.outputTokens).toBeGreaterThanOrEqual(0);
    expect(usage?.inputTokens).toBeDefined();
  });

  it("maps a bash + edit + read turn with paired results", () => {
    const { items } = normalizeOpencodeHistory(fixture("tools-turn.json"));
    const calls = toolCalls(items);
    const names = calls.map((c) => (c.type === "tool_call" ? c.name : ""));
    expect(names).toContain("edit");
    expect(names).toContain("read");
    expect(names).toContain("bash");
    for (const c of calls) {
      if (c.type !== "tool_call") continue;
      expect(c.status).toBe("completed");
      expect(c.error).toBeNull();
    }
    const edit = calls.find((c) => c.type === "tool_call" && c.name === "edit");
    expect(edit?.type === "tool_call" && edit.detail.type).toBe("edit");
    if (edit?.type === "tool_call" && edit.detail.type === "edit") {
      expect(edit.detail.oldString).toContain("line two");
      expect(edit.detail.unifiedDiff).toContain("line two edited");
    }
    // Two reads: pre-edit and post-edit. The post-edit one must carry the
    // new content (read success arrives via structured.content).
    const reads = calls.filter(
      (c) => c.type === "tool_call" && c.name === "read",
    );
    expect(reads.length).toBeGreaterThanOrEqual(2);
    const edited = reads.some(
      (c) =>
        c.type === "tool_call" &&
        c.detail.type === "read" &&
        c.detail.content.includes("line two edited"),
    );
    expect(edited).toBe(true);
    // Final assistant text closes the turn.
    const last = items[items.length - 1];
    expect(last).toMatchObject({ type: "assistant_message", text: "done" });
  });

  it("maps a failed tool call (bash-read fixture)", () => {
    const { items } = normalizeOpencodeHistory(fixture("bash-read-turn.json"));
    const calls = toolCalls(items);
    const failed = calls.filter(
      (c) => c.type === "tool_call" && c.status === "failed",
    );
    expect(failed.length).toBeGreaterThanOrEqual(1);
    for (const c of failed) {
      if (c.type !== "tool_call") continue;
      expect(typeof c.error).toBe("string");
      expect((c.error as string).length).toBeGreaterThan(0);
    }
    // Mid-turn step.ended (finish tool-calls) leaves no row.
    expect(
      items.every((i) => i.type !== "assistant_message" || i.text.length > 0),
    ).toBe(true);
  });

  it("keeps partial text on an interrupted turn", () => {
    const { items } = normalizeOpencodeHistory(
      fixture("interrupted-turn.json"),
    );
    expect(items[0]).toMatchObject({ type: "user_message" });
    const assistant = items.find((i) => i.type === "assistant_message");
    expect(assistant).toBeDefined();
    if (assistant?.type === "assistant_message") {
      expect(assistant.text.length).toBeGreaterThan(0);
    }
    // step.failed produces no timeline row (it becomes turn_failed live).
    expect(toolCalls(items)).toHaveLength(0);
  });

  it("maps a (synthetic) compaction to a divider", () => {
    const { items } = normalizeOpencodeHistory(fixture("compaction-turn.json"));
    const divider = items.find((i) => i.type === "compact_divider");
    expect(divider).toMatchObject({
      type: "compact_divider",
      trigger: "manual",
    });
  });
});

describe("mapOpencodeLiveEvent", () => {
  it("streams a text turn: append, deltas, reconcile, turn_failed on interrupt", () => {
    const state = createOpencodeLiveState();
    const deltas: EventDelta[] = [];
    const feed = (
      ev: { type: string; data: Record<string, unknown> },
      opts?: Parameters<typeof mapOpencodeLiveEvent>[2],
    ): EventDelta | null => {
      const d = mapOpencodeLiveEvent(ev, state, opts);
      if (d) deltas.push(d);
      return d;
    };

    // Prompt admission → user_message append (client uuid reuse).
    const userUuids = new Map([["msg_1", "client-uuid-1"]]);
    feed(
      {
        type: "session.next.prompt.admitted",
        data: {
          sessionID: "ses_1",
          messageID: "msg_1",
          prompt: { text: "hi" },
        },
      },
      { userMessageUuids: userUuids },
    );
    // The prompted echo dedupes by messageID.
    expect(
      feed({
        type: "session.next.prompted",
        data: {
          sessionID: "ses_1",
          messageID: "msg_1",
          prompt: { text: "hi" },
        },
      }),
    ).toBeNull();
    expect(deltas[0]).toMatchObject({
      kind: "append",
      item: { type: "user_message", uuid: "client-uuid-1", text: "hi" },
    });

    feed({
      type: "session.next.text.started",
      data: { sessionID: "ses_1", assistantMessageID: "a1", textID: "text-0" },
    });
    expect(deltas[1]).toMatchObject({
      kind: "append",
      item: { type: "assistant_message", uuid: "a1:text-0", text: "" },
    });

    // Live-only deltas from the global bus.
    feed({
      type: "session.next.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "a1",
        textID: "text-0",
        delta: "po",
      },
    });
    feed({
      type: "session.next.text.delta",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "a1",
        textID: "text-0",
        delta: "ng",
      },
    });
    expect(deltas[2]).toMatchObject({ kind: "patch_text", deltaText: "po" });
    // text.ended reconciles to a no-op when deltas covered the full text.
    expect(
      feed({
        type: "session.next.text.ended",
        data: {
          sessionID: "ses_1",
          assistantMessageID: "a1",
          textID: "text-0",
          text: "pong",
        },
      }),
    ).toBeNull();

    // Interrupted turn ends as step.failed → turn_failed.
    const failed = feed({
      type: "session.next.step.failed",
      data: {
        sessionID: "ses_1",
        assistantMessageID: "a1",
        error: { type: "unknown", message: "Provider turn interrupted" },
      },
    });
    expect(failed).toMatchObject({
      kind: "turn_failed",
      error: "Provider turn interrupted",
    });
  });

  it("reconciles text.ended when deltas were missed", () => {
    const state = createOpencodeLiveState();
    const d0 = mapOpencodeLiveEvent(
      {
        type: "session.next.text.started",
        data: { sessionID: "s", assistantMessageID: "a", textID: "text-0" },
      },
      state,
    );
    expect(d0?.kind).toBe("append");
    const d1 = mapOpencodeLiveEvent(
      {
        type: "session.next.text.ended",
        data: {
          sessionID: "s",
          assistantMessageID: "a",
          textID: "text-0",
          text: "pong",
        },
      },
      state,
    );
    expect(d1).toMatchObject({
      kind: "patch_text",
      uuid: "a:text-0",
      deltaText: "pong",
    });
  });

  it("replays recorded live deltas to the durable full text", () => {
    const raw = readFileSync(
      new URL("./__fixtures__/text-deltas.json", import.meta.url),
    );
    const live = JSON.parse(raw.toString()) as Array<{
      type: string;
      data: Record<string, unknown>;
    }>;
    const durable = fixture("text-turn.json");
    const ended = durable.find((e) => e.type === "session.next.text.ended");
    const fullText = (ended?.data.text as string) ?? "";
    expect(fullText.length).toBeGreaterThan(0);

    const state = createOpencodeLiveState();
    let acc = "";
    for (const ev of live) {
      const d = mapOpencodeLiveEvent(ev, state);
      if (d?.kind === "patch_text") acc += d.deltaText;
      if (d?.kind === "append" && d.item.type === "assistant_message") {
        acc += d.item.text;
      }
    }
    // Live concat == durable full text (the spike-2 merge invariant).
    expect(acc).toBe(fullText);
  });

  it("streams tool.called → patch on success with detail output", () => {
    const state = createOpencodeLiveState();
    const appended = mapOpencodeLiveEvent(
      {
        type: "session.next.tool.called",
        data: {
          sessionID: "s",
          assistantMessageID: "a",
          callID: "call_1",
          tool: "bash",
          input: { command: "echo hi" },
        },
      },
      state,
    );
    expect(appended).toMatchObject({
      kind: "append",
      item: { type: "tool_call", callId: "call_1", status: "running" },
    });
    const patched = mapOpencodeLiveEvent(
      {
        type: "session.next.tool.success",
        data: {
          sessionID: "s",
          assistantMessageID: "a",
          callID: "call_1",
          structured: {},
          content: [{ type: "text", text: "hi\n" }],
        },
      },
      state,
    );
    expect(patched).toMatchObject({
      kind: "patch_tool_call",
      callId: "call_1",
      status: "completed",
      error: null,
    });
    if (patched?.kind === "patch_tool_call" && patched.detail.type === "bash") {
      expect(patched.detail.output).toBe("hi\n");
    } else {
      expect.unreachable("expected bash patch detail");
    }
  });

  it("stashes step.ended usage and maps compaction lifecycle", () => {
    const state = createOpencodeLiveState();
    expect(
      mapOpencodeLiveEvent(
        {
          type: "session.next.step.ended",
          data: {
            sessionID: "s",
            assistantMessageID: "a",
            finish: "stop",
            cost: 0,
            tokens: {
              input: 10,
              output: 5,
              reasoning: 0,
              cache: { read: 3, write: 1 },
            },
          },
        },
        state,
      ),
    ).toBeNull();
    expect(state.lastUsage).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 1,
    });
    expect(
      mapOpencodeLiveEvent(
        {
          type: "session.next.compaction.started",
          data: { sessionID: "s", messageID: "m", reason: "manual" },
        },
        state,
      ),
    ).toMatchObject({ kind: "compact_started" });
    expect(
      mapOpencodeLiveEvent(
        {
          type: "session.next.compaction.ended",
          data: {
            sessionID: "s",
            messageID: "m",
            reason: "manual",
            text: "summary",
            recent: "recent",
          },
        },
        state,
      ),
    ).toMatchObject({ kind: "compact_applied", trigger: "manual" });
  });

  it("ignores non-transcript events", () => {
    const state = createOpencodeLiveState();
    for (const type of [
      "session.next.step.started",
      "session.next.tool.input.started",
      "session.next.reasoning.ended",
      "session.next.context.updated",
      "session.next.agent.switched",
      "session.next.model.switched",
    ]) {
      expect(
        mapOpencodeLiveEvent({ type, data: { sessionID: "s" } }, state),
      ).toBeNull();
    }
  });
});

describe("buildOpencodeDetail", () => {
  it("maps every brief-listed tool to its Thinkite detail type", () => {
    const cases: Array<[string, unknown, string]> = [
      ["bash", { command: "ls" }, "bash"],
      ["edit", { filePath: "f", oldString: "a", newString: "b" }, "edit"],
      ["edit", { path: "f", oldString: "a", newString: "b" }, "edit"],
      ["read", { filePath: "f" }, "read"],
      ["read", { path: "f", limit: 5 }, "read"],
      ["write", { filePath: "f", content: "x" }, "write"],
      ["glob", { pattern: "*.ts" }, "glob"],
      ["grep", { pattern: "foo" }, "grep"],
      ["webfetch", { url: "https://example.com" }, "web_fetch"],
      ["websearch", { query: "q" }, "web_search"],
      [
        "task",
        { description: "d", prompt: "p", subagent_type: "explore" },
        "agent",
      ],
      [
        "question",
        {
          questions: [
            {
              question: "q?",
              header: "h",
              options: [{ label: "a", description: "b" }],
              multiple: true,
            },
          ],
        },
        "ask_user",
      ],
      ["totally-made-up", { whatever: 1 }, "unknown"],
    ];
    for (const [tool, input, type] of cases) {
      expect(buildOpencodeDetail(tool, input).type).toBe(type);
    }
  });

  it("extracts step usage defensively", () => {
    expect(opencodeTurnUsage({})).toBeUndefined();
    expect(opencodeTurnUsage({ tokens: {} })).toBeUndefined();
  });
});
