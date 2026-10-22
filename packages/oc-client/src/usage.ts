import type { SessionMessageInfo } from "@opencode/client";

// How full a session's context is, worked out the way opencode's own
// clients do (`lastAssistantWithUsage` in @opencode/client's solid entry,
// v2.1.3): the latest reply that reports tokens, after the last completed
// compaction and before a staged revert.

type Assistant = Extract<SessionMessageInfo, { type: "assistant" }>;
export type TokenUsage = NonNullable<Assistant["tokens"]>;

/** The reply whose tokens fill the context now, if any has reported yet. */
export function lastAssistantWithUsage(
  rows: readonly SessionMessageInfo[],
  revert?: { messageID: string },
): (Assistant & { tokens: TokenUsage }) | undefined {
  const end =
    revert === undefined
      ? rows.length
      : rows.findIndex((m) => m.id === revert.messageID);
  if (end === -1) return undefined;
  const compaction = rows.findLastIndex(
    (m, i) => m.type === "compaction" && m.status === "completed" && i < end,
  );
  return rows.findLast(
    (m, i): m is Assistant & { tokens: TokenUsage } =>
      m.type === "assistant" &&
      m.tokens !== undefined &&
      i > compaction &&
      i < end,
  );
}

/** Every token the reply's request and answer took up. */
export function contextTokens(tokens: TokenUsage): number {
  return (
    tokens.input +
    tokens.output +
    tokens.reasoning +
    tokens.cache.read +
    tokens.cache.write
  );
}
