import type { SessionMessageInfo } from "@thinkite/oc-client";
import { describe, expect, it } from "vitest";
import { duration, rowsOf } from "./transcript-rows";

const user = (id: string, created: number) =>
  ({ id, type: "user", text: id, time: { created } }) as SessionMessageInfo;

const assistant = (
  id: string,
  content: unknown[],
  completed?: number,
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    type: "assistant",
    content,
    time: { created: 0, ...(completed ? { completed } : {}) },
    ...extra,
  }) as unknown as SessionMessageInfo;

const tool = (id: string) => ({
  type: "tool",
  id,
  name: "read",
  state: { status: "completed", input: { path: "/a" }, content: [] },
});
const text = (t: string) => ({ type: "text", text: t });

const idle = (id: string, outcome: string, created: number) =>
  ({ id, type: "idle", outcome, time: { created } }) as SessionMessageInfo;

const kinds = (rows: ReturnType<typeof rowsOf>) =>
  rows.map((r) => (r.kind === "process" ? `process(${r.label})` : r.kind));

describe("rowsOf", () => {
  it("folds a finished turn's work and leaves the final answer open", () => {
    const rows = rowsOf(
      [
        user("u1", 1_000),
        assistant("a1", [tool("t1")]),
        assistant("a2", [text("interim"), tool("t2")]),
        assistant("a3", [text("final")], 60_000),
        idle("i1", "succeeded", 64_000),
      ],
      false,
    );
    expect(kinds(rows)).toEqual([
      "user",
      "process(Completed in 1m 3s)",
      "text",
    ]);
    const process = rows[1];
    expect(
      process?.kind === "process" ? process.rows.map((r) => r.key) : [],
    ).toEqual(["tool:t1", "a2:0", "tool:t2"]);
  });

  it("keeps the running turn flat", () => {
    const rows = rowsOf(
      [user("u1", 1_000), assistant("a1", [tool("t1"), text("so far")])],
      true,
    );
    expect(kinds(rows)).toEqual(["user", "tool", "text"]);
  });

  it("ends a turn without an idle row at the next prompt, or when idle", () => {
    const rows = rowsOf(
      [
        user("u1", 1_000),
        assistant("a1", [tool("t1"), text("one")], 11_000),
        user("u2", 20_000),
        assistant("a2", [tool("t2"), text("two")], 25_000),
      ],
      false,
    );
    expect(kinds(rows)).toEqual([
      "user",
      "process(Completed in 10s)",
      "text",
      "user",
      "process(Completed in 5s)",
      "text",
    ]);
  });

  it("labels stops, and keeps a failure readable below the fold", () => {
    const stopped = rowsOf(
      [
        user("u1", 0),
        assistant("a1", [tool("t1")]),
        idle("i1", "interrupted", 5),
      ],
      false,
    );
    expect(kinds(stopped)).toEqual(["user", "process(Stopped)"]);

    const failed = rowsOf(
      [
        user("u1", 0),
        assistant("a1", [tool("t1")], undefined, {
          error: { message: "boom" },
        }),
        idle("i1", "failed", 5),
      ],
      false,
    );
    expect(kinds(failed)).toEqual(["user", "process(Failed)"]);
    const process = failed[1];
    expect(
      process?.kind === "process" ? process.rows.at(-1) : null,
    ).toMatchObject({
      kind: "note",
      text: "boom",
      tone: "danger",
    });
  });

  it("gives every row a distinct key", () => {
    const rows = rowsOf(
      [
        assistant("a0", [tool("t0"), text("tail of an older turn")]),
        user("u1", 1),
        assistant("a1", [tool("t1"), text("x")], 2),
        user("u2", 3),
        assistant("a2", [tool("t2")]),
      ],
      false,
    );
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("duration", () => {
  it("reads like a stopwatch", () => {
    expect(duration(400)).toBe("1s");
    expect(duration(63_000)).toBe("1m 3s");
    expect(duration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
  });
});
