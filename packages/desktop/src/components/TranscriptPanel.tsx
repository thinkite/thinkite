import { useEffect, useState } from "react";
import {
  ChatMessage,
  ChatMessageBubble,
  ChatMessageList,
  ChatToolCalls,
  type ChatToolCallItem,
} from "@astryxdesign/core/Chat";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";

// Offline transcript replay for ONE Claude session — the daemon record's
// cliSessionId keys the JSONL directly (/api/transcript, SDK
// getSessionMessages), no listSessions enumeration. A 404 means the JSONL was
// GC'd (Claude Code cleans transcripts after ~30 days) or the session ran on
// another machine — rendered as a notice, not an error.
//
// Plain DOM flow, no virtualization and no pagination — the parent ChatLayout
// owns the scroll container, stick-to-bottom (useChatStreamScroll starts
// locked; useChatNewMessages scrollIfLocked on content growth), and the
// scroll-to-bottom button. Consecutive tool events collapse into one
// ChatToolCalls group.
//
// Initial landing is ChatLayout's spring (animated flight for async-loaded
// rows — accepted for now): astryx has no instant path yet. Our upstream
// proposal adds `initial="instant"` (facebook/astryx#3795 / PR #3800);
// switch to it here when it ships and the flight disappears.

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
}: {
  dir: string;
  claudeSessionId: string;
}) {
  const [rows, setRows] = useState<TranscriptRow[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setRows(null);
    setNotice(null);
    void (async () => {
      try {
        const res = await fetch(
          `/api/transcript?session=${claudeSessionId}&dir=${encodeURIComponent(dir)}`,
        );
        if (res.status === 404) {
          setRows([]);
          setNotice(MISSING_NOTICE);
          return;
        }
        if (!res.ok) throw new Error(await res.text());
        setRows((await res.json()) as TranscriptRow[]);
      } catch (e) {
        setRows([]);
        setNotice(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [claudeSessionId, dir]);

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
      {rows === null || rows.length === 0
        ? null
        : toItems(rows).map((item) =>
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
          )}
    </ChatMessageList>
  );
}
