import {
  ChatLayoutScrollButton,
  ChatMessage,
  ChatMessageBubble,
  ChatSystemMessage,
  type ChatToolCallItem,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { eq, useLiveQuery } from "@tanstack/react-db";
import type { SessionMessageInfo } from "@thinkite/oc-client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getTranscriptCollection,
  loadOlderTranscript,
  transcriptPaging,
} from "../lib/oc";

// Live transcript for ONE opencode session. Rows are opencode's own
// `SessionMessageInfo` projection (see oc-client): the newest page is read
// from `message.list`, the running turn is folded from the bus by the
// reducer, and the projection tail is re-read when the turn ends. Older
// pages are prepended on demand — LegendList's `onStartReached` is the
// trigger (opencode's GUI: scrollTop < 200) and
// `maintainVisibleContentPosition` keeps the viewport still while they land.
//
// Virtualized through LegendList (same library as the iOS ChatPanel,
// catalog-pinned): the list owns the scroll container, the initial landing
// (initialScrollAtEnd — instant, no spring), streaming follow
// (maintainScrollAtEnd) and scroll-up anchoring
// (maintainVisibleContentPosition). Single scroll writer — nothing else may
// touch scrollTop. Astryx row components render unchanged; ChatMessage falls
// back to density 'balanced' outside ChatMessageList.
//
// Known virtualization trade-offs, accepted: find-in-page and cross-message
// selection only cover mounted rows; ChatToolCalls expansion state is lost
// once a row unmounts far off-screen. recycleItems stays OFF so row-internal
// state never leaks between rows.
//
// One projection row can render as several list rows: an assistant message
// is its content items in order (text / reasoning / tool), and consecutive
// tool items collapse into one ChatToolCalls group.

type TranscriptGroup =
  | { key: string; kind: "user"; messageId: string; text: string }
  | { key: string; kind: "text"; text: string }
  | { key: string; kind: "reasoning"; text: string }
  | { key: string; kind: "system"; text: string }
  | { key: string; kind: "tools"; calls: ChatToolCallItem[] };

type ToolItem = Extract<
  Extract<SessionMessageInfo, { type: "assistant" }>["content"][number],
  { type: "tool" }
>;

const TOOL_STATUS = {
  streaming: "running",
  running: "running",
  completed: "complete",
  error: "error",
} as const;

/** One-line target for a tool row: the most descriptive input field. */
function toolTarget(tool: ToolItem): string | undefined {
  const input = tool.state.input;
  if (typeof input === "string")
    return input === "" ? undefined : input.slice(0, 120);
  for (const key of [
    "filePath",
    "path",
    "command",
    "pattern",
    "query",
    "url",
    "description",
  ]) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function toolCall(tool: ToolItem): ChatToolCallItem {
  const target = toolTarget(tool);
  return {
    key: tool.id,
    name: tool.name,
    ...(target !== undefined ? { target } : {}),
    status: TOOL_STATUS[tool.state.status],
    ...(tool.state.status === "error"
      ? { error: tool.state.error.message }
      : {}),
  };
}

function toGroups(messages: SessionMessageInfo[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  const pushTool = (call: ChatToolCallItem) => {
    const prev = groups.at(-1);
    if (prev?.kind === "tools") prev.calls.push(call);
    else
      groups.push({ key: `tools:${call.key}`, kind: "tools", calls: [call] });
  };
  for (const message of messages) {
    switch (message.type) {
      case "user":
        groups.push({
          key: message.id,
          kind: "user",
          messageId: message.id,
          text: message.text,
        });
        break;
      case "assistant": {
        message.content.forEach((item, index) => {
          const key = `${message.id}:${index}`;
          if (item.type === "text") {
            if (item.text !== "")
              groups.push({ key, kind: "text", text: item.text });
          } else if (item.type === "reasoning") {
            if (item.text !== "")
              groups.push({ key, kind: "reasoning", text: item.text });
          } else {
            pushTool(toolCall(item));
          }
        });
        if (message.error !== undefined) {
          groups.push({
            key: `${message.id}:error`,
            kind: "system",
            text: message.error.message,
          });
        }
        break;
      }
      case "synthetic":
      case "system":
        groups.push({
          key: message.id,
          kind: "system",
          text: message.description ?? message.text,
        });
        break;
      case "compaction":
        groups.push({
          key: message.id,
          kind: "system",
          text:
            message.status === "running"
              ? "Compacting context…"
              : "Context compacted",
        });
        break;
      case "agent-switched":
        groups.push({
          key: message.id,
          kind: "system",
          text: `Agent: ${message.agent}`,
        });
        break;
      case "model-switched":
        groups.push({
          key: message.id,
          kind: "system",
          text: `Model: ${message.model.providerID}/${message.model.id}`,
        });
        break;
      case "location-switched":
        groups.push({
          key: message.id,
          kind: "system",
          text: `Moved to ${message.location.directory}`,
        });
        break;
      case "shell":
        groups.push({
          key: message.id,
          kind: "system",
          text: `$ ${message.command}`,
        });
        break;
      case "skill":
        groups.push({
          key: message.id,
          kind: "system",
          text: `Skill: ${message.name}`,
        });
        break;
    }
  }
  return groups;
}

// Resident thinking footer, the iOS ChatPanel idiom: ALWAYS mounted at a
// constant height with only the label fading. Constant footerSize is the
// point — a footer mount/unmount changes anchoredEndSpace's
// contentBelowAnchor without triggering its recompute, which jumps the
// anchored message. Also doubles as the gap below the last message.
function ThinkingFooter({ active }: { active: boolean }) {
  return (
    <div
      className={`chat-col h-10 transition-opacity duration-200 ${active ? "opacity-100" : "opacity-0"}`}
      aria-hidden={!active}
    >
      <ChatMessage sender="assistant">
        <Text
          size="base"
          color="secondary"
          className="motion-safe:animate-pulse"
        >
          Thinking…
        </Text>
      </ChatMessage>
    </div>
  );
}

function OlderHeader({ loading }: { loading: boolean }) {
  return (
    <div
      className={`chat-col h-8 transition-opacity duration-200 ${loading ? "opacity-100" : "opacity-0"}`}
    >
      <Text size="sm" color="secondary">
        Loading earlier messages…
      </Text>
    </div>
  );
}

function renderGroup(group: TranscriptGroup) {
  switch (group.kind) {
    case "tools":
      return <ChatToolCalls calls={group.calls} />;
    case "user":
      return (
        <ChatMessage sender="user">
          <ChatMessageBubble>
            <Markdown>{group.text}</Markdown>
          </ChatMessageBubble>
        </ChatMessage>
      );
    case "text":
      return (
        <ChatMessage sender="assistant">
          <Markdown>{group.text}</Markdown>
        </ChatMessage>
      );
    case "reasoning":
      // Model thinking — secondary, small; streaming rows keep appending
      // below.
      return (
        <ChatMessage sender="assistant">
          <Text size="sm" color="secondary">
            {group.text}
          </Text>
        </ChatMessage>
      );
    case "system":
      return (
        <ChatSystemMessage variant="divider">{group.text}</ChatSystemMessage>
      );
  }
}

const EMPTY_NOTICE = "Nothing here yet — send a prompt to start the session.";

export function TranscriptPanel({
  sessionId,
  isRunning,
  anchorUuid = null,
}: {
  sessionId: string;
  /** Renders a working indicator under the last message (busy/idle from
   *  the session-states collection). */
  isRunning?: boolean;
  /** Id of the most recently sent user message — pinned near the viewport
   *  top while the response streams into reserved space below it. The iOS
   *  ChatPanel lifecycle: kept ACROSS turns (clearing on idle collapses the
   *  reserved space and jumps the viewport); the next send re-anchors; the
   *  per-session remount resets it. Follow (maintainScrollAtEnd) stays ON —
   *  after anchoring the viewport isn't at the end, so follow is naturally
   *  dormant until the user scrolls or jumps to the tail. */
  anchorUuid?: string | null;
}) {
  const collection = useMemo(
    () => getTranscriptCollection(sessionId),
    [sessionId],
  );
  const { data: messages, isLoading } = useLiveQuery(
    (q) =>
      q
        .from({ t: collection })
        .orderBy(({ t }) => t.time.created, "asc")
        .orderBy(({ t }) => t.id, "asc"),
    [collection],
  );
  const { data: pagingRows } = useLiveQuery(
    (q) =>
      q.from({ p: transcriptPaging }).where(({ p }) => eq(p.id, sessionId)),
    [sessionId],
  );
  const paging = pagingRows[0];
  const hasOlder = paging?.hasOlder === true;
  const loadingOlder = paging?.loading === true;

  const groups = useMemo(() => toGroups(messages), [messages]);

  // iOS's isThinking rule: the turn is running but the last row isn't the
  // assistant's text yet — the initial think window + tool gaps. Rendered
  // by the resident ThinkingFooter (constant height, label fades).
  const isThinking = isRunning === true && groups.at(-1)?.kind !== "text";

  // Pin the just-sent prompt near the top; the reply streams into the space
  // the list reserves below it. No exclusion against maintainScrollAtEnd —
  // anchoring leaves the viewport away from the end, so follow sleeps until
  // the user reaches the tail (the iOS arbitration). id → index lookup
  // instead of iOS's send-time index because desktop groups fold consecutive
  // tool calls, so indices shift. 16px ≈ the container's top breathing room.
  const anchoredEndSpace = useMemo(() => {
    if (anchorUuid === null) return undefined;
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      if (g?.kind === "user" && g.messageId === anchorUuid) {
        return { anchorIndex: i, anchorOffset: 16 };
      }
    }
    return undefined;
  }, [groups, anchorUuid]);

  const listRef = useRef<LegendListRef | null>(null);
  // Scroll-to-bottom affordance, driven by the list's own follow state — the
  // same isAtEnd the maintainScrollAtEnd machinery uses, so button visibility
  // can never disagree with whether the list is actually following.
  const [atEnd, setAtEnd] = useState(true);
  const hasRows = groups.length > 0;
  useEffect(() => {
    if (!hasRows) return;
    const state = listRef.current?.getState();
    if (state === undefined) return;
    setAtEnd(state.isAtEnd);
    return state.listen("isAtEnd", setAtEnd);
  }, [hasRows]);

  // On send, position the anchored prompt. scrollToEnd is "committed" since
  // @legendapp/list 3.0.4: it queues until the data commit lands and the
  // anchored tail has measured (the iOS send path relies on the same).
  useEffect(() => {
    if (anchorUuid === null) return;
    void listRef.current?.scrollToEnd({ animated: true });
  }, [anchorUuid]);

  if (!hasRows) {
    return (
      <div className="flex h-full items-center justify-center">
        {isLoading || paging?.hydrated !== true || isRunning === true ? (
          <Spinner size="sm" label="Loading transcript…" />
        ) : (
          <Text size="sm" color="secondary">
            {EMPTY_NOTICE}
          </Text>
        )}
      </div>
    );
  }

  return (
    <div role="log" aria-label="Transcript" className="relative h-full">
      <LegendList
        ref={listRef}
        data={groups}
        keyExtractor={(g) => g.key}
        // Column width lives INSIDE the row (t3code): rows are full-width
        // absolutely-positioned, so the reading column is a per-row centered
        // wrapper — the scroll container stays full-width and keeps the
        // scrollbar at the pane edge. overflow-x-clip stops a wide code block
        // from blowing the column open.
        renderItem={({ item }) => (
          <div className="chat-col overflow-x-clip pb-3">
            {renderGroup(item)}
          </div>
        )}
        getItemType={(g) => g.kind}
        estimatedItemSize={120}
        recycleItems={false}
        alignItemsAtEnd
        initialScrollAtEnd
        {...(anchoredEndSpace !== undefined ? { anchoredEndSpace } : {})}
        maintainScrollAtEnd
        maintainVisibleContentPosition
        // Older pages: half a viewport from the top asks for the next page;
        // the collection ignores the call while one is in flight or when
        // nothing older exists.
        onStartReached={
          hasOlder ? () => void loadOlderTranscript(sessionId) : undefined
        }
        onStartReachedThreshold={0.5}
        ListHeaderComponent={<OlderHeader loading={loadingOlder} />}
        ListFooterComponent={<ThinkingFooter active={isThinking} />}
        // t3code container hygiene: horizontal padding lives on the scroll
        // container (rows stay full-width), overscroll stays contained, and
        // the gutter is reserved so the scrollbar never reflows content.
        // overflow-anchor: none is already set by the list itself.
        className="px-3 pt-2 overscroll-y-contain scrollbar-gutter-stable"
        style={{ height: "100%" }}
      />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 [&_button]:pointer-events-auto">
        <ChatLayoutScrollButton
          isVisible={!atEnd}
          onClick={() => {
            void listRef.current?.scrollToEnd({ animated: true });
          }}
        />
      </div>
    </div>
  );
}
