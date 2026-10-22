import {
  ChatLayoutScrollButton,
  ChatMessage,
  ChatMessageBubble,
  ChatSystemMessage,
  ChatToolCalls,
} from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  type SessionMessageInfo,
  toolDiffs,
  toolOutput,
  toolSummary,
} from "@thinkite/oc-client";
import { useMessages, usePaging } from "@thinkite/oc-client/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ocStore } from "../lib/oc";

// Live transcript for ONE opencode session, laid out like wisp's: user
// bubbles, the agent's text as markdown, a foldable "Thought for Ns" per
// reasoning part, one row per tool call that expands to its diff or
// output, and one-line notes for compaction, shell runs, retries and turns
// that did not succeed. Rows are opencode's own `SessionMessageInfo`
// projection from the store; older pages are prepended on demand —
// LegendList's `onStartReached` is the trigger (opencode's GUI: scrollTop <
// 200) and `maintainVisibleContentPosition` keeps the viewport still while
// they land.
//
// Virtualized through LegendList (same library as the iOS ChatPanel): the
// list owns the scroll container, the initial landing (initialScrollAtEnd),
// streaming follow (maintainScrollAtEnd) and scroll-up anchoring
// (maintainVisibleContentPosition). Single scroll writer — nothing else may
// touch scrollTop. Find-in-page and cross-message selection only cover
// mounted rows, and a tool row's open state is lost once it unmounts far
// off-screen; recycleItems stays OFF so row-internal state never leaks
// between rows.

type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>;
type Part = AssistantMessage["content"][number];
type ReasoningPart = Extract<Part, { type: "reasoning" }>;
type ToolPart = Extract<Part, { type: "tool" }>;

type TranscriptRow =
  | { key: string; kind: "user"; messageId: string; text: string }
  | { key: string; kind: "text"; text: string }
  | { key: string; kind: "reasoning"; part: ReasoningPart }
  | { key: string; kind: "tool"; tool: ToolPart }
  | { key: string; kind: "note"; text: string; tone: "quiet" | "danger" }
  | { key: string; kind: "process"; label: string; rows: TranscriptRow[] };

const TOOL_STATUS = {
  streaming: "running",
  running: "running",
  completed: "complete",
  error: "error",
} as const;

/** File extension → highlighter language for a diff; plain text otherwise. */
function languageOf(file: string): string | undefined {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  const known: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    json: "json",
    md: "markdown",
    css: "css",
    html: "html",
    py: "python",
    rs: "rust",
    go: "go",
    swift: "swift",
    sh: "bash",
  };
  return known[ext];
}

/** "12s", "1m 3s", "2h 5m". */
function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Rows per turn, after DeepSeek Harness's transcript: once a turn has
 * ended, everything the agent did on the way — thinking, tool calls,
 * interim text, notes — folds into one "Completed in 1m 3s" row and only
 * the final answer stays open. The running turn stays flat, so its work
 * shows as it happens.
 */
function rowsOf(
  messages: readonly SessionMessageInfo[],
  running: boolean,
): TranscriptRow[] {
  const out: TranscriptRow[] = [];
  let turn: TranscriptRow[] = [];
  let turnKey = "";
  let started: number | undefined;
  let finished: number | undefined;

  type Ending = {
    outcome: "succeeded" | "interrupted" | "failed";
    at: number | undefined;
  } | null;
  const close = (ending: Ending, notes: TranscriptRow[] = []) => {
    if (ending === null) {
      out.push(...turn);
    } else {
      // The final answer: the text rows after the last row of any other kind.
      let split = turn.length;
      while (split > 0 && turn[split - 1]?.kind === "text") split--;
      const process = turn.slice(0, split);
      const label =
        ending.outcome === "succeeded"
          ? started !== undefined && ending.at !== undefined
            ? `Completed in ${duration(ending.at - started)}`
            : "Completed"
          : ending.outcome === "interrupted"
            ? "Stopped"
            : "Failed";
      if (process.length > 0)
        out.push({
          key: `process:${turnKey}`,
          kind: "process",
          label,
          rows: process,
        });
      out.push(...turn.slice(split));
      // A failure stays readable below the fold; a stop is in the label,
      // unless there was nothing to fold.
      if (ending.outcome === "failed" || process.length === 0)
        out.push(...notes);
    }
    turn = [];
    finished = undefined;
  };
  // Sessions from before opencode wrote idle rows end a turn only by the
  // next prompt, or by going idle; the last reply's completion stands in
  // for the turn's end time.
  const implicitEnd = (): Ending =>
    turn.length > 0 ? { outcome: "succeeded", at: finished } : null;

  messages.forEach((message, index) => {
    const rows = messageRows(messages, index);
    if (message.type === "user") {
      close(implicitEnd());
      out.push(...rows);
      turnKey = message.id;
      started = message.time.created;
    } else if (message.type === "idle") {
      close({ outcome: message.outcome, at: message.time.created }, rows);
    } else {
      if (message.type === "assistant" && message.time.completed !== undefined)
        finished = message.time.completed;
      turn.push(...rows);
    }
  });
  close(running ? null : implicitEnd());
  return out;
}

function messageRows(
  messages: readonly SessionMessageInfo[],
  index: number,
): TranscriptRow[] {
  const message = messages[index] as SessionMessageInfo;
  const rows: TranscriptRow[] = [];
  const note = (
    key: string,
    text: string,
    tone: "quiet" | "danger" = "quiet",
  ) => rows.push({ key, kind: "note", text, tone });
  switch (message.type) {
    case "user":
      rows.push({
        key: message.id,
        kind: "user",
        messageId: message.id,
        text: message.text,
      });
      break;
    case "assistant":
      message.content.forEach((part, i) => {
        const key = `${message.id}:${i}`;
        if (part.type === "text") {
          if (part.text !== "")
            rows.push({ key, kind: "text", text: part.text });
        } else if (part.type === "reasoning") {
          if (part.text.trim() !== "" || part.time?.completed === undefined)
            rows.push({ key, kind: "reasoning", part });
        } else {
          rows.push({ key: `tool:${part.id}`, kind: "tool", tool: part });
        }
      });
      if (message.retry !== undefined)
        note(
          `${message.id}:retry`,
          `Retrying (attempt ${message.retry.attempt}): ${message.retry.error.message}`,
        );
      if (message.error !== undefined)
        note(`${message.id}:error`, message.error.message, "danger");
      break;
    case "synthetic":
      note(message.id, message.description ?? message.text);
      break;
    case "shell":
      note(message.id, `$ ${message.command}`);
      break;
    case "compaction":
      note(
        message.id,
        message.status === "running"
          ? "Compacting context…"
          : "Context compacted",
      );
      break;
    case "idle": {
      if (message.outcome === "succeeded") break;
      if (message.outcome === "interrupted") {
        note(message.id, "Interrupted");
        break;
      }
      // A failed turn already shows its error on the assistant row.
      const previous = messages[index - 1];
      if (previous?.type === "assistant" && previous.error !== undefined) break;
      note(message.id, `Failed: ${message.error?.message ?? ""}`, "danger");
      break;
    }
    // Agent and model switches, skills and the rest have nothing to show.
    default:
      break;
  }
  return rows;
}

function Reasoning({ part }: { part: ReasoningPart }) {
  const thinking = part.time?.completed === undefined;
  const seconds =
    part.time?.completed !== undefined && part.time.created !== undefined
      ? Math.max(
          1,
          Math.round((part.time.completed - part.time.created) / 1000),
        )
      : null;
  return (
    <Collapsible
      defaultIsOpen={false}
      trigger={
        <Text size="sm" color="secondary">
          {thinking
            ? "Thinking…"
            : seconds
              ? `Thought for ${seconds}s`
              : "Thought"}
        </Text>
      }
    >
      <Text size="sm" color="secondary" className="whitespace-pre-wrap">
        {part.text}
      </Text>
    </Collapsible>
  );
}

/** The last few path segments: enough to tell files apart in a title. */
function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

/** A patch without its `---`/`+++` file header, which the block's title repeats. */
function hunksOf(patch: string): string {
  const lines = patch.split("\n");
  const first = lines.findIndex((l) => l.startsWith("@@"));
  return first <= 0 ? patch : lines.slice(first).join("\n");
}

function ToolDetail({ tool }: { tool: ToolPart }) {
  const diffs = toolDiffs(tool);
  if (diffs.length > 0) {
    return (
      <div className="flex flex-col gap-2">
        {diffs.map((d) => (
          <CodeBlock
            key={d.file}
            code={hunksOf(d.patch)}
            isDiff
            title={shortPath(d.file)}
            maxHeight={480}
            {...(languageOf(d.file) ? { language: languageOf(d.file) } : {})}
          />
        ))}
      </div>
    );
  }
  if (tool.state.status === "error") return null;
  const output = toolOutput(tool);
  if (output === "") return null;
  return <CodeBlock code={output} maxHeight={480} />;
}

function ToolRow({ tool }: { tool: ToolPart }) {
  const diffs = toolDiffs(tool);
  const summary = toolSummary(tool);
  return (
    <ChatToolCalls
      calls={[
        {
          key: tool.id,
          name: tool.name,
          status: TOOL_STATUS[tool.state.status],
          ...(summary !== "" ? { target: summary } : {}),
          ...(diffs.length > 0
            ? {
                additions: diffs.reduce((n, d) => n + d.additions, 0),
                deletions: diffs.reduce((n, d) => n + d.deletions, 0),
              }
            : {}),
          ...(tool.state.status === "error"
            ? { errorMessage: tool.state.error.message }
            : {}),
          resultDetail: <ToolDetail tool={tool} />,
        },
      ]}
    />
  );
}

// Resident working footer, the iOS ChatPanel idiom: ALWAYS mounted at a
// constant height with only the label fading. Constant footerSize is the
// point — a footer mount/unmount changes anchoredEndSpace's
// contentBelowAnchor without triggering its recompute, which jumps the
// anchored message. Also doubles as the gap below the last message. The
// label counts the turn's time, as DeepSeek Harness's does.
function WorkingFooter({
  active,
  since,
}: {
  active: boolean;
  since: number | undefined;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return (
    <div
      className={`chat-col h-10 transition-opacity duration-200 ${active ? "opacity-100" : "opacity-0"}`}
      aria-hidden={!active}
    >
      <Text size="sm" color="secondary" className="motion-safe:animate-pulse">
        {since !== undefined && now > since
          ? `Working for ${duration(now - since)}`
          : "Working…"}
      </Text>
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

function renderRow(row: TranscriptRow) {
  switch (row.kind) {
    case "user":
      return (
        <ChatMessage sender="user">
          <ChatMessageBubble>
            <Markdown>{row.text}</Markdown>
          </ChatMessageBubble>
        </ChatMessage>
      );
    case "text":
      return (
        <ChatMessage sender="assistant">
          <Markdown>{row.text}</Markdown>
        </ChatMessage>
      );
    case "reasoning":
      return <Reasoning part={row.part} />;
    case "process":
      return (
        <Collapsible
          defaultIsOpen={false}
          trigger={
            <Text size="sm" color="secondary">
              {row.label}
            </Text>
          }
        >
          <div className="flex flex-col gap-3">
            {row.rows.map((r) => (
              <div key={r.key}>{renderRow(r)}</div>
            ))}
          </div>
        </Collapsible>
      );
    case "tool":
      return <ToolRow tool={row.tool} />;
    case "note":
      return (
        <ChatSystemMessage variant="divider">
          {row.tone === "danger" ? (
            <span style={{ color: "var(--color-text-red)" }}>{row.text}</span>
          ) : (
            row.text
          )}
        </ChatSystemMessage>
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
  /** Renders a working indicator under the last message. */
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
  useEffect(() => {
    void ocStore.open(sessionId);
  }, [sessionId]);
  const messages = useMessages(ocStore, sessionId);
  const paging = usePaging(ocStore, sessionId);
  const hasOlder = paging.cursor !== undefined;

  const rows = useMemo(
    () => rowsOf(messages, isRunning === true),
    [messages, isRunning],
  );

  // iOS's isThinking rule: the turn is running but the last row isn't the
  // assistant's text yet — the initial think window + tool gaps. Rendered
  // by the resident WorkingFooter (constant height, label fades).
  const isThinking = isRunning === true && rows.at(-1)?.kind !== "text";
  // When the running turn began: its user message.
  const turnStarted = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.type === "user") return m.time.created;
    }
    return undefined;
  }, [messages]);

  // Pin the just-sent prompt near the top; the reply streams into the space
  // the list reserves below it. No exclusion against maintainScrollAtEnd —
  // anchoring leaves the viewport away from the end, so follow sleeps until
  // the user reaches the tail (the iOS arbitration). id → index lookup
  // instead of iOS's send-time index because one message becomes several
  // rows, so indices shift. 16px ≈ the container's top breathing room.
  const anchoredEndSpace = useMemo(() => {
    if (anchorUuid === null) return undefined;
    for (let i = rows.length - 1; i >= 0; i--) {
      const g = rows[i];
      if (g?.kind === "user" && g.messageId === anchorUuid) {
        return { anchorIndex: i, anchorOffset: 16 };
      }
    }
    return undefined;
  }, [rows, anchorUuid]);

  const listRef = useRef<LegendListRef | null>(null);
  // Scroll-to-bottom affordance, driven by the list's own follow state — the
  // same isAtEnd the maintainScrollAtEnd machinery uses, so button visibility
  // can never disagree with whether the list is actually following.
  const [atEnd, setAtEnd] = useState(true);
  const hasRows = rows.length > 0;
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
        {!paging.hydrated || isRunning === true ? (
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
        data={rows}
        keyExtractor={(g) => g.key}
        // Column width lives INSIDE the row (t3code): rows are full-width
        // absolutely-positioned, so the reading column is a per-row centered
        // wrapper — the scroll container stays full-width and keeps the
        // scrollbar at the pane edge. overflow-x-clip stops a wide code block
        // from blowing the column open.
        renderItem={({ item }) => (
          <div className="chat-col overflow-x-clip pb-3">{renderRow(item)}</div>
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
        // the store ignores the call while one is in flight.
        onStartReached={
          hasOlder ? () => void ocStore.loadOlder(sessionId) : undefined
        }
        onStartReachedThreshold={0.5}
        ListHeaderComponent={<OlderHeader loading={paging.loadingOlder} />}
        ListFooterComponent={
          <WorkingFooter active={isThinking} since={turnStarted} />
        }
        // t3code container hygiene: horizontal padding lives on the scroll
        // container (rows stay full-width), overscroll stays contained, and
        // the gutter is reserved so the scrollbar never reflows content.
        // overflow-anchor: none is already set by the list itself.
        className="pt-4 overscroll-y-contain scrollbar-gutter-stable"
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
