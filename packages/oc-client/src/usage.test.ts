import type { SessionMessageInfo } from "@opencode/client";
import { describe, expect, it } from "vitest";
import { contextTokens, lastAssistantWithUsage } from "./usage.ts";

const tokens = (input: number) => ({
  input,
  output: 10,
  reasoning: 5,
  cache: { read: 100, write: 1 },
});
const assistant = (id: string, input?: number) =>
  ({
    type: "assistant",
    id,
    ...(input !== undefined ? { tokens: tokens(input) } : {}),
  }) as unknown as SessionMessageInfo;
const user = (id: string) => ({ type: "user", id }) as SessionMessageInfo;
const compaction = (id: string, status: string) =>
  ({ type: "compaction", id, status }) as unknown as SessionMessageInfo;

describe("context usage", () => {
  it("takes the latest reply that reports tokens", () => {
    const rows = [
      user("m1"),
      assistant("m2", 1000),
      user("m3"),
      assistant("m4"),
    ];
    expect(lastAssistantWithUsage(rows)?.id).toBe("m2");
    expect(contextTokens(tokens(1000))).toBe(1116);
  });

  it("starts over after a completed compaction", () => {
    const rows = [
      assistant("m1", 9000),
      compaction("m2", "running"),
      assistant("m3", 8000),
      compaction("m4", "completed"),
      user("m5"),
    ];
    expect(lastAssistantWithUsage(rows)).toBeUndefined();
    expect(lastAssistantWithUsage([...rows, assistant("m6", 500)])?.id).toBe(
      "m6",
    );
  });

  it("stops before a staged revert", () => {
    const rows = [assistant("m1", 1000), user("m2"), assistant("m3", 2000)];
    expect(lastAssistantWithUsage(rows, { messageID: "m2" })?.id).toBe("m1");
    expect(lastAssistantWithUsage(rows, { messageID: "gone" })).toBeUndefined();
  });
});
