import { describe, expect, it } from "vitest";
import { groupSessionsByDay } from "./session-sections";

const at = (y: number, m: number, d: number, h = 12) =>
  new Date(y, m, d, h).getTime();

describe("groupSessionsByDay", () => {
  it("returns no sections for an empty list", () => {
    expect(groupSessionsByDay([], at(2026, 5, 10))).toEqual([]);
  });

  it("buckets a recency-sorted list into Today / Yesterday / dated sections", () => {
    const now = at(2026, 5, 10);
    const rows = [
      { id: "c", updatedAt: at(2026, 5, 10, 9) },
      { id: "b", updatedAt: at(2026, 5, 10, 8) },
      { id: "a", updatedAt: at(2026, 5, 9, 22) },
      { id: "old", updatedAt: at(2026, 5, 1) },
    ];

    const sections = groupSessionsByDay(rows, now);

    expect(sections.map((s) => s.title)).toEqual([
      "Today",
      "Yesterday",
      "Jun 1",
    ]);
    expect(sections[0]?.data.map((r) => r.id)).toEqual(["c", "b"]);
    expect(sections[1]?.data.map((r) => r.id)).toEqual(["a"]);
    expect(sections[2]?.data.map((r) => r.id)).toEqual(["old"]);
  });

  it("does not merge non-adjacent days", () => {
    const now = at(2026, 5, 10);
    const rows = [
      { updatedAt: at(2026, 5, 10) },
      { updatedAt: at(2026, 5, 8) },
      { updatedAt: at(2026, 5, 10, 23) },
    ];

    const sections = groupSessionsByDay(rows, now);

    expect(sections.map((s) => s.title)).toEqual(["Today", "Jun 8", "Today"]);
    expect(sections.map((s) => s.data.length)).toEqual([1, 1, 1]);
  });
});
