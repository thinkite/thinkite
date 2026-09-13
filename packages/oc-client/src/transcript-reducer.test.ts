/**
 * Reducer tests driven by a real recorded turn pair
 * (`scripts/record-oc-fixtures.ts`): folding the streaming events must
 * reproduce the server's `session_message` projection row for row, and
 * merging a projection page must replace rows by id without dropping
 * local-only ones.
 */

import { readFileSync } from "node:fs";
import type { SessionMessageInfo } from "@opencode/client";
import { describe, expect, it } from "vitest";
import type { OcEvent } from "./events.ts";
import {
  applyTranscriptEvent,
  mergeProjection,
  STREAMING_EVENT_TYPES,
  type TranscriptRows,
} from "./transcript-reducer.ts";

const fixture = JSON.parse(
  readFileSync(
    new URL("./__fixtures__/two-turns.json", import.meta.url),
    "utf8",
  ),
) as { events: OcEvent[]; messages: SessionMessageInfo[] };

function fold(events: readonly OcEvent[]): TranscriptRows {
  let rows: TranscriptRows = [];
  for (const event of events) rows = applyTranscriptEvent(rows, event);
  return rows;
}

describe("transcript reducer", () => {
  it("folds a recorded pong + read-tool turn into the server projection", () => {
    const rows = fold(fixture.events);
    expect(rows.map((r) => r.id)).toEqual(fixture.messages.map((m) => m.id));
    expect(rows).toEqual(fixture.messages);
  });

  it("only touches rows for the streaming subset and keeps identity otherwise", () => {
    const rows = fold(fixture.events);
    for (const event of fixture.events) {
      if (STREAMING_EVENT_TYPES.has(event.type)) continue;
      expect(applyTranscriptEvent(rows, event)).toBe(rows);
    }
    // A delta for an unknown message is dropped, not appended.
    const stray = fixture.events.find((e) => e.type === "session.text.delta");
    expect(stray).toBeDefined();
    const orphan = {
      ...stray,
      data: {
        ...(stray as { data: object }).data,
        assistantMessageID: "msg_missing",
      },
    } as OcEvent;
    expect(applyTranscriptEvent(rows, orphan)).toBe(rows);
  });

  it("accumulates deltas and settles on ended with the full text", () => {
    const upTo = (type: string, nth: number) => {
      let seen = 0;
      const out: OcEvent[] = [];
      for (const event of fixture.events) {
        out.push(event);
        if (event.type === type && ++seen === nth) break;
      }
      return out;
    };
    const streaming = fold(upTo("session.text.delta", 1));
    const first = streaming.find((r) => r.type === "assistant");
    expect(first?.type).toBe("assistant");
    if (first?.type !== "assistant") return;
    const text = first.content.find((c) => c.type === "text");
    expect(text?.type).toBe("text");
    expect(first.time.completed).toBeUndefined();
    const ended = fold(upTo("session.step.ended", 1));
    const settled = ended.find((r) => r.id === first.id);
    expect(settled?.type).toBe("assistant");
    if (settled?.type !== "assistant") return;
    expect(settled.time.completed).toBeDefined();
    expect(settled.finish).toBe("stop");
    expect(settled.content.find((c) => c.type === "text")?.text).toBe("pong");
  });

  it("mergeProjection replaces by id, appends unknown rows, keeps local-only rows", () => {
    const local: SessionMessageInfo = {
      id: "msg_local",
      type: "user",
      text: "queued locally",
      time: { created: 9 },
    };
    const [a, b] = fixture.messages;
    if (a === undefined || b === undefined)
      throw new Error("fixture too small");
    const stale = { ...a, text: "old" } as SessionMessageInfo;
    const rows: TranscriptRows = [stale, local];
    const merged = mergeProjection(rows, [a, b]);
    expect(merged.map((r) => r.id)).toEqual([a.id, "msg_local", b.id]);
    expect(merged[0]).toBe(a);
    expect(merged[1]).toBe(local);
    expect(mergeProjection(rows, [])).toBe(rows);
  });
});
