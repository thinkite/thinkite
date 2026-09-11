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
import { useLiveQuery } from "@tanstack/react-db";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  getTranscriptCollection,
  type OrderedOcRow,
} from "../lib/transcript-collections";

// Live transcript for ONE opencode session, folded from the v2 history +
// session stream + global bus through the oc-client reducer: the
// per-session collection mirrors reducer rows, then folds EventDeltas —
// appends, token-level patch_text on the assistant row, tool_call status
// patches. Reconnects resume with `after=` (durable replay + `*.ended`
// reconcile); either way this component just renders the live rows.
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
// Consecutive tool rows collapse into one ChatToolCalls group; a
// tool_use without its result renders as `running` until the patch lands.

type TranscriptGroup =
  | { key: string; kind: "item"; item: OrderedOcRow }
  | { key: string; kind: "tools"; calls: ChatToolCallItem[] };

const TOOL_STATUS = {
  running: "running",
  completed: "complete",
  error: "error",
} as const;

function toGroups(items: OrderedOcRow[]): TranscriptGroup[] {
  const groups: TranscriptGroup[] = [];
  for (const item of items) {
    if (item.kind === "tool") {
      const call: ChatToolCallItem = {
        key: item.id,
        name: item.name,
        target: item.summary,
        status: TOOL_STATUS[item.status],
        ...(item.error !== null ? { error: item.error } : {}),
      };
      const prev = groups.at(-1);
      if (prev?.kind === "tools") prev.calls.push(call);
      else groups.push({ key: item.id, kind: "tools", calls: [call] });
    } else {
      groups.push({ key: item.id, kind: "item", item });
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

function renderGroup(group: TranscriptGroup) {
  switch (group.kind) {
    case "tools":
      return <ChatToolCalls calls={group.calls} />;
    case "item": {
      const item = group.item;
      switch (item.kind) {
        case "user":
          return (
            <ChatMessage sender="user">
              <ChatMessageBubble>
                <Markdown>{item.text}</Markdown>
              </ChatMessageBubble>
            </ChatMessage>
          );
        case "text":
          return (
            <ChatMessage sender="assistant">
              <Markdown>{item.text}</Markdown>
            </ChatMessage>
          );
        case "reasoning":
          // Model thinking — secondary, small; streaming rows keep
          // appending below.
          return (
            <ChatMessage sender="assistant">
              <Text size="sm" color="secondary">
                {item.text}
              </Text>
            </ChatMessage>
          );
        case "compaction":
          return (
            <ChatSystemMessage variant="divider">
              {item.reason === "auto"
                ? "Context compacted automatically"
                : "Context compacted"}
            </ChatSystemMessage>
          );
        case "step-failed":
          return (
            <ChatSystemMessage variant="divider">
              {item.error}
            </ChatSystemMessage>
          );
        case "revert":
          return (
            <ChatSystemMessage variant="divider">
              {item.state === "committed"
                ? "Reverted to checkpoint"
                : item.state === "staged"
                  ? "Revert staged"
                  : "Revert cleared"}
            </ChatSystemMessage>
          );
        default:
          return null;
      }
    }
  }
}

const EMPTY_NOTICE = "Nothing here yet — send a prompt to start the session.";

export function TranscriptPanel({
  sessionId,
  isRunning,
  anchorUuid = null,
}: {
  sessionId: string;
  /** Renders a working indicator under the last message (opencode
   *  `session.status` via the session-states collection). */
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
  const { data: items, isLoading } = useLiveQuery(
    (q) => q.from({ t: collection }).orderBy(({ t }) => t._order, "asc"),
    [collection],
  );

  // iOS's isThinking rule: the turn is running but the last item isn't
  // the assistant's text yet — the initial think window + tool gaps.
  // Rendered by the resident ThinkingFooter (constant height, label fades).
  const isThinking = isRunning === true && items.at(-1)?.kind !== "text";

  const groups = useMemo(() => toGroups(items), [items]);

  // Pin the just-sent prompt near the top; the reply streams into the space
  // the list reserves below it. No exclusion against maintainScrollAtEnd —
  // anchoring leaves the viewport away from the end, so follow sleeps until
  // the user reaches the tail (the iOS arbitration). uuid → index lookup
  // instead of iOS's send-time index because desktop groups fold consecutive
  // tool calls, so indices shift. 16px ≈ the container's top breathing room.
  const anchoredEndSpace = useMemo(() => {
    if (anchorUuid === null) return undefined;
    for (let i = groups.length - 1; i >= 0; i--) {
      const g = groups[i];
      if (
        g?.kind === "item" &&
        g.item.kind === "user" &&
        g.item.id === anchorUuid
      ) {
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

  // A session with no JSONL on this machine subscribes fine and settles
  // to an empty snapshot — indistinguishable from truly-empty, and a real
  // session always has at least its first prompt.
  if (!hasRows) {
    return (
      <div className="flex h-full items-center justify-center">
        {isLoading || isRunning === true ? (
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
        getItemType={(g) => (g.kind === "item" ? g.item.kind : g.kind)}
        estimatedItemSize={120}
        recycleItems={false}
        alignItemsAtEnd
        initialScrollAtEnd
        {...(anchoredEndSpace !== undefined ? { anchoredEndSpace } : {})}
        maintainScrollAtEnd
        maintainVisibleContentPosition
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
