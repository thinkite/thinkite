import type { SessionMessageInfo } from "@thinkite/oc-client";
import { describe, expect, it } from "vitest";
import { duration, groupLabel, rowsOf } from "./transcript-rows";

const user = (id: string, created: number) =>
  ({ id, type: "user", text: id, time: { created } }) as SessionMessageInfo;

const assistant = (
  id: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    type: "assistant",
    content,
    time: { created: 0 },
    ...extra,
  }) as unknown as SessionMessageInfo;

const tool = (id: string, name = "read", status = "completed") => ({
  type: "tool",
  id,
  name,
  state: { status, input: { path: "/a" }, content: [] },
});
const text = (t: string) => ({ type: "text", text: t });
const thought = (t: string) => ({ type: "reasoning", text: t });

const idle = (id: string, outcome: string, created: number) =>
  ({ id, type: "idle", outcome, time: { created } }) as SessionMessageInfo;

const shape = (rows: ReturnType<typeof rowsOf>) =>
  rows.map((r) =>
    r.kind === "group"
      ? `group(${r.items.map((i) => i.key).join(",")})`
      : r.kind,
  );

describe("rowsOf", () => {
  it("shows inline files on the user row, not @-mentioned ones", () => {
    const message = {
      ...user("u1", 1),
      files: [
        {
          data: "AAAA",
          mime: "image/png",
          source: { type: "inline" },
          name: "shot.png",
        },
        {
          data: "BBBB",
          mime: "text/plain",
          source: { type: "file" },
          name: "a.ts",
          mention: { start: 0, end: 5, text: "@a.ts" },
        },
      ],
    } as unknown as SessionMessageInfo;
    const [row] = rowsOf([message]);
    expect(row?.kind === "user" ? row.attachments : null).toEqual([
      {
        name: "shot.png",
        mime: "image/png",
        src: "data:image/png;base64,AAAA",
      },
    ]);
  });

  it("stacks a run of tools and thinking into one group, across steps", () => {
    const rows = rowsOf([
      user("u1", 1),
      assistant("a1", [thought("hm"), tool("t1"), tool("t2", "grep")]),
      assistant("a2", [tool("t3", "glob")]),
      assistant("a3", [text("done")]),
    ]);
    expect(shape(rows)).toEqual([
      "user",
      "group(a1:0,tool:t1,tool:t2,tool:t3)",
      "text",
    ]);
  });

  it("breaks a run at text, and at the next prompt", () => {
    const rows = rowsOf([
      user("u1", 1),
      assistant("a1", [tool("t1"), text("one"), tool("t2", "edit")]),
      user("u2", 2),
      assistant("a2", [tool("t3", "shell")]),
    ]);
    expect(shape(rows)).toEqual([
      "user",
      "group(tool:t1)",
      "text",
      "group(tool:t2)",
      "user",
      "group(tool:t3)",
    ]);
  });

  it("keeps a group's key while the run grows", () => {
    const before = rowsOf([user("u1", 1), assistant("a1", [tool("t1")])]);
    const after = rowsOf([
      user("u1", 1),
      assistant("a1", [tool("t1"), tool("t2")]),
    ]);
    expect(before[1]?.key).toBe(after[1]?.key);
  });

  it("shows a finished question alone, hides a waiting one and the todo list", () => {
    const rows = rowsOf([
      user("u1", 1),
      assistant("a1", [
        tool("t1"),
        tool("q1", "question"),
        tool("todo", "todowrite"),
        tool("q2", "question", "running"),
        tool("t2"),
      ]),
    ]);
    expect(shape(rows)).toEqual([
      "user",
      "group(tool:t1)",
      "tool",
      "group(tool:t2)",
    ]);
  });

  it("drops blank text and thinking", () => {
    const rows = rowsOf([
      user("u1", 1),
      assistant("a1", [text("  "), thought(""), tool("t1")]),
    ]);
    expect(shape(rows)).toEqual(["user", "group(tool:t1)"]);
  });

  it("ends a run at a note, and reports stops and failures", () => {
    const stopped = rowsOf([
      user("u1", 0),
      assistant("a1", [tool("t1")]),
      idle("i1", "interrupted", 5),
    ]);
    expect(shape(stopped)).toEqual(["user", "group(tool:t1)", "note"]);
    expect(stopped.at(-1)).toMatchObject({ text: "Interrupted" });

    const failed = rowsOf([
      user("u1", 0),
      assistant("a1", [tool("t1")], { error: { message: "boom" } }),
      idle("i1", "failed", 5),
    ]);
    expect(failed.at(-1)).toMatchObject({
      kind: "note",
      text: "boom",
      tone: "danger",
    });
    expect(failed.filter((r) => r.kind === "note")).toHaveLength(1);
  });

  it("puts the model and the turn's time under its last text, once it's over", () => {
    const flash = { providerID: "deepseek", id: "flash", variant: "max" };
    const rows = rowsOf([
      user("u1", 1000),
      assistant("a1", [text("looking"), tool("t1")], {
        model: flash,
        time: { created: 1000, completed: 3000 },
      }),
      assistant("a2", [text("done"), thought("hm")], {
        model: flash,
        time: { created: 3000, completed: 13000 },
      }),
      user("u2", 20000),
      assistant("a3", [text("still going")], {
        model: flash,
        time: { created: 20000 },
      }),
    ]);
    const metas = rows.flatMap((r) =>
      r.kind === "text" ? [[r.text, r.meta]] : [],
    );
    expect(metas).toEqual([
      ["looking", undefined],
      ["done", { model: flash, durationMs: 12000 }],
      // Unfinished: no time yet.
      ["still going", { model: flash }],
    ]);
    const running = rowsOf(
      [user("u1", 0), assistant("a1", [text("hi")], { model: flash })],
      true,
    );
    expect(running.find((r) => r.kind === "text")).not.toHaveProperty("meta");
  });

  it("gives every row a distinct key", () => {
    const rows = rowsOf([
      assistant("a0", [tool("t0"), text("tail of an older turn")]),
      user("u1", 1),
      assistant("a1", [tool("t1"), text("x")]),
      user("u2", 3),
      assistant("a2", [tool("t2")]),
    ]);
    const keys = rows.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("groupLabel", () => {
  it("counts tool calls and lists their titles once", () => {
    const rows = rowsOf([
      user("u1", 1),
      assistant("a1", [
        thought("x"),
        tool("t1"),
        tool("t2", "grep"),
        tool("t3", "read"),
        tool("t4", "bash"),
      ]),
    ]);
    const group = rows[1];
    expect(group?.kind === "group" ? groupLabel(group.items) : "").toBe(
      "Used 4 Read, Grep, Shell",
    );
  });

  it("counts thoughts when nothing else ran", () => {
    const rows = rowsOf([
      user("u1", 1),
      assistant("a1", [thought("a"), thought("b")]),
    ]);
    const group = rows[1];
    expect(group?.kind === "group" ? groupLabel(group.items) : "").toBe(
      "Used 2 Thoughts",
    );
  });
});

describe("duration", () => {
  it("reads like a stopwatch", () => {
    expect(duration(400)).toBe("1s");
    expect(duration(63_000)).toBe("1m 3s");
    expect(duration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
  });
});
