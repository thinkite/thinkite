import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatSystemMessage,
  type ChatToolCallItem,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import {
  getTranscriptCollection,
  type OrderedTimelineItem,
} from "../lib/transcript-collections";

// Live transcript for ONE Claude session, streamed over the daemon's
// subscribe channel: the per-session collection ingests the settled
// snapshot on attach, then folds EventDeltas — appends, token-level
// patch_text on the assistant row, tool_call status patches. Reconnects
// resume warm (cursor/epoch) or rebuild cold inside one sync transaction;
// either way this component just renders the live rows.
//
// Plain DOM flow, no virtualization and no pagination — the parent
// ChatLayout owns the scroll container, stick-to-bottom (useChatStreamScroll
// starts locked; useChatNewMessages scrollIfLocked on content growth), and
// the scroll-to-bottom button. Consecutive tool_call rows collapse into one
// ChatToolCalls group; a tool_use without its result renders as `running`
// until the patch lands.
//
// Initial landing is ChatLayout's spring (animated flight for async-loaded
// rows — accepted for now): our upstream fix makes first-fill instant
// unconditionally (facebook/astryx#3795 / PR #3800); bump the dep when it
// ships and the flight disappears.

type TranscriptGroup =
  | { key: string; kind: "item"; item: OrderedTimelineItem }
  | { key: string; kind: "tools"; calls: ChatToolCallItem[] };

const TOOL_STATUS = {
  running: "running",
  completed: "complete",
  failed: "error",
} as const;

function toGroups(items: OrderedTimelineItem[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  for (const item of items) {
    if (item.type === "tool_call") {
      const call: ChatToolCallItem = {
        key: item.callId,
        name: item.name,
        target: item.summary,
        status: TOOL_STATUS[item.status],
        ...(item.error !== null ? { error: item.error } : {}),
      };
      const prev = groups.at(-1);
      if (prev?.kind === "tools") prev.calls.push(call);
      else groups.push({ key: item.callId, kind: "tools", calls: [call] });
    } else {
      groups.push({ key: item.uuid, kind: "item", item });
    }
  }
  return groups;
}

const EMPTY_NOTICE =
  "No transcript on this machine — it may have been cleaned up (30-day GC) or created on another device.";

export function TranscriptPanel({
  claudeSessionId,
  isRunning,
}: {
  claudeSessionId: string;
  /** Renders a working indicator under the last message (daemon-pushed
   *  sessionState.activity). */
  isRunning?: boolean;
}) {
  const collection = useMemo(
    () => getTranscriptCollection(claudeSessionId),
    [claudeSessionId],
  );
  const { data: items, isLoading } = useLiveQuery(
    (q) => q.from({ t: collection }).orderBy(({ t }) => t._order, "asc"),
    [collection],
  );

  // A session with no JSONL on this machine subscribes fine and settles
  // to an empty snapshot — indistinguishable from truly-empty, and a real
  // session always has at least its first prompt.
  return (
    <ChatMessageList
      gap={3}
      emptyState={
        isLoading ? (
          <Spinner size="sm" label="Loading transcript…" />
        ) : (
          <Text size="sm" color="secondary">
            {EMPTY_NOTICE}
          </Text>
        )
      }
    >
      {items.length === 0 && !isRunning
        ? null
        : [
            ...toGroups(items).map((group) => {
              if (group.kind === "tools") {
                return <ChatToolCalls key={group.key} calls={group.calls} />;
              }
              const item = group.item;
              switch (item.type) {
                case "user_message":
                  return (
                    <ChatMessage key={group.key} sender="user">
                      <ChatMessageBubble>
                        <Markdown>{item.text}</Markdown>
                      </ChatMessageBubble>
                    </ChatMessage>
                  );
                case "assistant_message":
                  return (
                    <ChatMessage key={group.key} sender="assistant">
                      <Markdown>{item.text}</Markdown>
                      {item.stopReason === null ? (
                        <Text size="sm" color="secondary">
                          [stopped]
                        </Text>
                      ) : null}
                    </ChatMessage>
                  );
                case "compact_divider":
                  return (
                    <ChatSystemMessage key={group.key} variant="divider">
                      {`Context compacted · ${Math.round(item.preTokens / 1000)}k → ${Math.round(item.postTokens / 1000)}k (${item.trigger})`}
                    </ChatSystemMessage>
                  );
                default:
                  return null;
              }
            }),
            ...(isRunning
              ? [
                  <ChatMessage key="__running" sender="assistant">
                    <Spinner size="sm" label="Working…" />
                  </ChatMessage>,
                ]
              : []),
          ]}
    </ChatMessageList>
  );
}
