import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  type ChatToolCallItem,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useEffect, useState } from "react";

// Transcript replay for ONE Claude session — the daemon record's
// cliSessionId keys the JSONL directly (/api/transcript, SDK
// getSessionMessages), no listSessions enumeration. A 404 means the JSONL was
// GC'd (Claude Code cleans transcripts after ~30 days) or the session ran on
// another machine — rendered as a notice, not an error.
//
// Live updates are TRANSITION-driven, not streamed: `refreshKey` (the
// session row's lastActivityAt) bumps at turn start and turn end, and each
// bump refetches while keeping the current rows on screen — the user bubble
// appears instantly via `pending` (optimistic, deduped against fetched rows
// by uuid: the daemon persists the client-supplied userMessageUuid), and the
// assistant reply lands on the turn-end refetch. Token-level streaming
// (EventDelta folding) is the next slice.
//
// Plain DOM flow, no virtualization and no pagination — the parent ChatLayout
// owns the scroll container, stick-to-bottom (useChatStreamScroll starts
// locked; useChatNewMessages scrollIfLocked on content growth), and the
// scroll-to-bottom button. Consecutive tool events collapse into one
// ChatToolCalls group.
//
// Initial landing is ChatLayout's spring (animated flight for async-loaded
// rows — accepted for now): astryx has no instant path yet. Our upstream
// proposal makes first-fill instant unconditionally (facebook/astryx#3795 /
// PR #3800); bump the dep when it ships and the flight disappears.

interface TranscriptRow {
  uuid: string;
  kind: "user" | "assistant" | "tool";
  text?: string;
  tool?: { name: string; summary: string };
  timestamp?: string;
}

type TranscriptItem =
  | { key: string; kind: "message"; sender: "user" | "assistant"; text: string }
  | { key: string; kind: "tools"; calls: ChatToolCallItem[] };

function toItems(rows: TranscriptRow[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  for (const row of rows) {
    if (row.kind === "tool") {
      const call: ChatToolCallItem = {
        key: row.uuid,
        name: row.tool!.name,
        target: row.tool!.summary,
      };
      const prev = items.at(-1);
      if (prev?.kind === "tools") prev.calls.push(call);
      else items.push({ key: row.uuid, kind: "tools", calls: [call] });
    } else {
      items.push({
        key: row.uuid,
        kind: "message",
        sender: row.kind,
        text: row.text ?? "",
      });
    }
  }
  return items;
}

const MISSING_NOTICE =
  "No transcript on this machine — it may have been cleaned up (30-day GC) or created on another device.";

export function TranscriptPanel({
  dir,
  claudeSessionId,
  refreshKey,
  pending,
  isRunning,
}: {
  dir: string;
  claudeSessionId: string;
  /** Bump to refetch while KEEPING current rows on screen (rows only reset
   *  when the session/dir changes). Wire to the live session row's
   *  lastActivityAt: it moves at turn start and turn end. */
  refreshKey?: number;
  /** Optimistically-sent user messages; hidden once the fetched transcript
   *  contains their uuid. */
  pending?: Array<{ uuid: string; text: string }>;
  /** Renders a working indicator under the last message. */
  isRunning?: boolean;
}) {
  const [rows, setRows] = useState<TranscriptRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Reset only on a genuine target change — a refreshKey bump must not
  // blank the list into the loading state mid-conversation.
  useEffect(() => {
    setRows(null);
    setNotice(null);
  }, [claudeSessionId, dir]);

  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/transcript?session=${claudeSessionId}&dir=${encodeURIComponent(dir)}`,
        );
        if (stale) return;
        if (res.status === 404) {
          setRows([]);
          setNotice(MISSING_NOTICE);
          return;
        }
        if (!res.ok) throw new Error(await res.text());
        const fetched = (await res.json()) as TranscriptRow[];
        if (!stale) setRows(fetched);
      } catch (e) {
        if (stale) return;
        setRows([]);
        setNotice(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      // A newer fetch (session switch OR refresh) supersedes this one; a
      // slow stale response must not overwrite fresher rows.
      stale = true;
    };
  }, [claudeSessionId, dir, refreshKey]);

  // The daemon persists our optimistic uuid as the user_message uuid, so
  // "fetched row exists with this uuid" is the exact settle signal.
  const confirmed = new Set((rows ?? []).map((r) => r.uuid));
  const pendingRows = (pending ?? []).filter((p) => !confirmed.has(p.uuid));
  const hasContent =
    (rows !== null && rows.length > 0) || pendingRows.length > 0 || isRunning;

  // The SDK returns [] for a missing JSONL rather than throwing, so empty
  // and absent are indistinguishable — and a real session always has at
  // least its first prompt, so treat both as "not on this machine".
  return (
    <ChatMessageList
      gap={3}
      emptyState={
        rows === null ? (
          <Spinner size="sm" label="Loading transcript…" />
        ) : (
          <Text size="sm" color="secondary">
            {notice ?? MISSING_NOTICE}
          </Text>
        )
      }
    >
      {!hasContent
        ? null
        : [
            ...toItems(rows ?? []).map((item) =>
              item.kind === "tools" ? (
                <ChatToolCalls key={item.key} calls={item.calls} />
              ) : item.sender === "user" ? (
                <ChatMessage key={item.key} sender="user">
                  <ChatMessageBubble>
                    <Markdown>{item.text}</Markdown>
                  </ChatMessageBubble>
                </ChatMessage>
              ) : (
                <ChatMessage key={item.key} sender="assistant">
                  <Markdown>{item.text}</Markdown>
                </ChatMessage>
              ),
            ),
            ...pendingRows.map((p) => (
              <ChatMessage key={p.uuid} sender="user">
                <ChatMessageBubble>
                  <Markdown>{p.text}</Markdown>
                </ChatMessageBubble>
              </ChatMessage>
            )),
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
