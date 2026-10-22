import { Button } from "@astryxdesign/core/Button";
import {
  ChatLayoutScrollButton,
  ChatMessage,
  ChatMessageBubble,
  ChatMessageMetadata,
  ChatSystemMessage,
} from "@astryxdesign/core/Chat";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Icon } from "@astryxdesign/core/Icon";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  toolDiffs,
  toolOutput,
  toolSummary,
  visibleMessages,
} from "@thinkite/oc-client";
import { useMessages, usePaging, useSession } from "@thinkite/oc-client/react";
import {
  BotIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CopyIcon,
  Redo2Icon,
  SplitIcon,
  Undo2Icon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { highlightTokens } from "../lib/highlight";
import { ocStore } from "../lib/oc";
import { modelName, useModels, variantLabel } from "./ModelPicker";
import {
  agentSessionOf,
  duration,
  type GroupItem,
  groupLabel,
  type ReasoningPart,
  type ReplyMeta,
  rowsOf,
  type ToolPart,
  type TranscriptRow,
  toolTitle,
} from "./transcript-rows";

// Live transcript for ONE opencode session, laid out like opencode
// desktop's compact timeline: user bubbles, the agent's text as markdown,
// and between two pieces of text one collapsed "Used 3 Read, Grep, Glob"
// row that opens into a line per tool call or thought, each of which opens
// to its diff or output; one-line notes for compaction, shell runs,
// retries and turns that did not succeed. Rows are opencode's own
// `SessionMessageInfo` projection from the store; older pages are
// prepended on demand —
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

/**
 * File extension → highlighter language for a diff. Highlights takes most
 * extensions as language aliases (ts, py, rs, kt, yml…); the rest render
 * plain.
 */
function languageOf(file: string): string | undefined {
  const dot = file.lastIndexOf(".");
  return dot === -1 ? undefined : file.slice(dot + 1).toLowerCase();
}

/**
 * A fenced code block in the agent's markdown, as Markdown draws it by
 * default (wrapped, collapsible, `diff` fences as diffs) but tokenized by
 * highlights. Markdown hands a custom renderer only the fence's first word,
 * so `diff-tsx` arrives as `diff` and renders as a plain diff.
 */
function CodeFence({ code, language }: { code: string; language?: string }) {
  const isDiff = language === "diff";
  return (
    <div className="my-3 first:mt-0 last:mb-0">
      <CodeBlock
        code={code}
        isDiff={isDiff}
        isCollapsible
        isWrapped
        tokenizer={highlightTokens}
        {...(!isDiff && language !== undefined ? { language } : {})}
      />
    </div>
  );
}

const MARKDOWN_COMPONENTS = { code: CodeFence };

/**
 * opencode's disclosure: the label with a small ▾ right after it (not at
 * the far edge), and the content indented below. Without content it is a
 * plain line.
 */
function Disclosure({
  label,
  children,
}: {
  label: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (children === undefined || children === null)
    return (
      <div className="flex min-w-0 items-center gap-1.5 py-1">{label}</div>
    );
  return (
    <div className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="group flex min-w-0 cursor-pointer items-center gap-1.5 self-start rounded py-1 text-left"
      >
        {label}
        <ChevronDownIcon
          aria-hidden
          className={`size-3.5 shrink-0 text-[var(--color-text-secondary)] transition ${open ? "" : "-rotate-90 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"}`}
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-1 pt-1 pl-3">{children}</div>
      ) : null}
    </div>
  );
}

const PULSE = "motion-safe:animate-pulse";

function ThoughtLine({ part }: { part: ReasoningPart }) {
  const thinking = part.time?.completed === undefined;
  const took =
    part.time?.completed !== undefined && part.time.created !== undefined
      ? duration(part.time.completed - part.time.created)
      : null;
  return (
    <Disclosure
      label={
        <>
          <Text size="sm" weight="medium" className={thinking ? PULSE : ""}>
            {thinking ? "Thinking" : "Thought"}
          </Text>
          {took !== null ? (
            <Text size="sm" color="secondary">
              {took}
            </Text>
          ) : null}
        </>
      }
    >
      <Text size="sm" color="secondary" className="whitespace-pre-wrap">
        {part.text}
      </Text>
    </Disclosure>
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

/** What a tool line opens to: its diffs, its error, or its output. */
function toolDetail(tool: ToolPart): ReactNode {
  const diffs = toolDiffs(tool);
  if (diffs.length > 0) {
    return diffs.map((d) => (
      <CodeBlock
        key={d.file}
        code={hunksOf(d.patch)}
        isDiff
        title={shortPath(d.file)}
        width="100%"
        size="sm"
        maxHeight={480}
        tokenizer={highlightTokens}
        {...(languageOf(d.file) ? { language: languageOf(d.file) } : {})}
      />
    ));
  }
  if (tool.state.status === "error") {
    return (
      <Text
        size="sm"
        className="whitespace-pre-wrap"
        style={{ color: "var(--color-text-red)" }}
      >
        {tool.state.error.message}
      </Text>
    );
  }
  const output = toolOutput(tool);
  if (output === "") return null;
  // A command's card is titled with the command, as opencode's shell card.
  const command =
    tool.name === "shell" || tool.name === "bash" ? toolSummary(tool) : "";
  return (
    <CodeBlock
      code={output}
      width="100%"
      size="sm"
      maxHeight={480}
      {...(command !== "" ? { title: `$ ${command}` } : {})}
    />
  );
}

/** One tool call: "Read  …/src/app.ts  +3 −1", opening to its detail. */
function ToolLine({ tool }: { tool: ToolPart }) {
  const status = tool.state.status;
  const pending = status === "streaming" || status === "running";
  const failed = status === "error";
  const summary = toolSummary(tool);
  const diffs = toolDiffs(tool);
  const added = diffs.reduce((n, d) => n + d.additions, 0);
  const removed = diffs.reduce((n, d) => n + d.deletions, 0);
  return (
    <Disclosure
      label={
        <>
          <Text
            size="sm"
            weight="medium"
            className={`shrink-0 ${pending ? PULSE : ""}`}
            {...(failed ? { style: { color: "var(--color-text-red)" } } : {})}
          >
            {toolTitle(tool.name)}
          </Text>
          {summary !== "" ? (
            <Text size="sm" color="secondary" className="truncate font-mono">
              {summary}
            </Text>
          ) : null}
          {diffs.length > 0 ? (
            <Text size="sm" className="shrink-0 font-mono tabular-nums">
              <span style={{ color: "var(--color-text-green)" }}>+{added}</span>{" "}
              <span style={{ color: "var(--color-text-red)" }}>−{removed}</span>
            </Text>
          ) : null}
        </>
      }
    >
      {toolDetail(tool)}
    </Disclosure>
  );
}

/**
 * A subagent's run on its own line, as opencode places it: "Agent", what it
 * was asked to do, and how it is going; a click opens its session (once the
 * service has made it).
 */
function AgentRow({
  tool,
  onOpenSession,
}: {
  tool: ToolPart;
  onOpenSession: ((sessionID: string) => void) | undefined;
}) {
  const status = tool.state.status;
  const pending = status === "streaming" || status === "running";
  const failed = status === "error";
  const sessionID = agentSessionOf(tool);
  const summary = toolSummary(tool);
  const canOpen = sessionID !== undefined && onOpenSession !== undefined;
  return (
    <button
      type="button"
      disabled={!canOpen}
      onClick={() => {
        if (sessionID !== undefined) onOpenSession?.(sessionID);
      }}
      className="group -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left enabled:cursor-pointer enabled:hover:bg-[var(--color-background-secondary)]"
    >
      <Icon icon={BotIcon} size="sm" color="secondary" />
      <Text
        size="sm"
        weight="medium"
        className="shrink-0"
        {...(failed ? { style: { color: "var(--color-text-red)" } } : {})}
      >
        Agent
      </Text>
      {summary !== "" ? (
        <Text size="sm" color="secondary" className="truncate">
          {summary}
        </Text>
      ) : null}
      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {pending ? (
          <Spinner size="sm" shade="subtle" />
        ) : failed ? (
          <Text size="sm" style={{ color: "var(--color-text-red)" }}>
            Failed
          </Text>
        ) : null}
        {canOpen ? (
          <Icon icon={ChevronRightIcon} size="sm" color="secondary" />
        ) : null}
      </span>
    </button>
  );
}

/** opencode's "Used 3 Read, Grep, Glob ▾": a run of tool calls and thinking. */
function GroupRow({ items, live }: { items: GroupItem[]; live: boolean }) {
  const pending =
    live ||
    items.some((i) =>
      i.kind === "tool"
        ? i.tool.state.status === "running" ||
          i.tool.state.status === "streaming"
        : i.part.time?.completed === undefined,
    );
  const label = groupLabel(items);
  return (
    <Disclosure
      label={
        <Text size="sm" className={pending ? PULSE : ""}>
          <span style={{ color: "var(--color-text-secondary)" }}>Used </span>
          <span className="font-medium">{label.slice("Used ".length)}</span>
        </Text>
      }
    >
      {items.map((i) =>
        i.kind === "tool" ? (
          <ToolLine key={i.key} tool={i.tool} />
        ) : (
          <ThoughtLine key={i.key} part={i.part} />
        ),
      )}
    </Disclosure>
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

/** What a prompt in the transcript offers, after opencode's user message. */
export interface MessageActions {
  /** Rewind to just before this prompt (its text goes back in the composer). */
  revert(messageId: string, text: string): Promise<void>;
  /** Start a new session from the history before this prompt. */
  fork(messageId: string, text: string): Promise<void>;
  /** Bring back what a revert hid. */
  redo(): Promise<void>;
}

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

function ActionButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: typeof CheckIcon;
  onClick: () => void | Promise<void>;
}) {
  return (
    <Button
      label={label}
      tooltip={label}
      variant="ghost"
      size="sm"
      isIconOnly
      // Sized and tinted like the time beside it.
      icon={<Icon icon={icon} size="xsm" color="secondary" />}
      clickAction={onClick}
    />
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <ActionButton
      label={copied ? "Copied" : label}
      icon={copied ? CheckIcon : CopyIcon}
      onClick={() =>
        navigator.clipboard.writeText(text).then(
          () => setCopied(true),
          (err: unknown) => console.warn("[copy] failed:", err),
        )
      }
    />
  );
}

/**
 * The line under a turn's last text, as opencode's: copy, then the model,
 * its reasoning effort when not the default, and how long the turn took.
 */
function ReplyLine({ text, meta }: { text: string; meta: ReplyMeta }) {
  const models = useModels();
  const { variant } = meta.model;
  const label = [
    modelName(models, meta.model),
    variant !== undefined && variant !== "default" ? variantLabel(variant) : "",
    meta.durationMs !== undefined ? duration(meta.durationMs) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <ChatMessageMetadata
      footer={
        <span className="flex items-center gap-1">
          <CopyButton text={text} label="Copy response" />
          <span>{label}</span>
        </span>
      }
    />
  );
}

/**
 * The line under a prompt, always shown: its time, then revert, fork and
 * copy (opencode shows revert and copy on hover and forks from a dialog).
 */
function UserMeta({
  row,
  actions,
}: {
  row: Extract<TranscriptRow, { kind: "user" }>;
  actions: MessageActions | undefined;
}) {
  return (
    <ChatMessageMetadata
      timestamp={TIME.format(row.created)}
      footer={
        <span className="flex items-center">
          {actions !== undefined && (
            <>
              <ActionButton
                label="Revert message"
                icon={Undo2Icon}
                onClick={() => actions.revert(row.messageId, row.text)}
              />
              <ActionButton
                label="Fork to new session"
                icon={SplitIcon}
                onClick={() => actions.fork(row.messageId, row.text)}
              />
            </>
          )}
          {row.text !== "" && (
            <CopyButton text={row.text} label="Copy message" />
          )}
        </span>
      }
    />
  );
}

function renderRow(
  row: TranscriptRow,
  live: boolean,
  actions: MessageActions | undefined,
  onOpenSession: ((sessionID: string) => void) | undefined,
) {
  switch (row.kind) {
    case "user":
      return (
        <ChatMessage sender="user">
          {row.attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap justify-end gap-2">
              {row.attachments.map((a, i) => (
                <Thumbnail
                  // Files never change once sent; their order is stable.
                  key={i}
                  {...(a.mime.startsWith("image/") ? { src: a.src } : {})}
                  alt={a.name}
                  label={a.name}
                />
              ))}
            </div>
          )}
          {row.text !== "" ? (
            <ChatMessageBubble
              metadata={<UserMeta row={row} actions={actions} />}
            >
              <Markdown components={MARKDOWN_COMPONENTS}>{row.text}</Markdown>
            </ChatMessageBubble>
          ) : (
            <UserMeta row={row} actions={actions} />
          )}
        </ChatMessage>
      );
    case "text":
      return (
        <ChatMessage
          sender="assistant"
          {...(row.meta !== undefined
            ? { metadata: <ReplyLine text={row.text} meta={row.meta} /> }
            : {})}
        >
          <Markdown components={MARKDOWN_COMPONENTS}>{row.text}</Markdown>
        </ChatMessage>
      );
    case "group":
      return <GroupRow items={row.items} live={live} />;
    case "tool":
      return <ToolLine tool={row.tool} />;
    case "agent":
      return <AgentRow tool={row.tool} onOpenSession={onOpenSession} />;
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
    case "reverted":
      return (
        <div className="flex items-center justify-center gap-2">
          <Text size="sm" color="secondary">
            {row.count === 1
              ? "1 message reverted"
              : `${row.count} messages reverted`}
          </Text>
          {actions !== undefined && (
            <Button
              label="Redo"
              variant="ghost"
              size="sm"
              icon={<Icon icon={Redo2Icon} size="sm" />}
              clickAction={() => actions.redo()}
            />
          )}
        </div>
      );
  }
}

const EMPTY_NOTICE = "Nothing here yet — send a prompt to start the session.";

export function TranscriptPanel({
  sessionId,
  isRunning,
  anchorUuid = null,
  actions,
  onOpenSession,
}: {
  sessionId: string;
  /** Revert, fork and redo; without them prompts offer only copy. */
  actions?: MessageActions;
  /** Open a subagent's session from its line. */
  onOpenSession?: (sessionID: string) => void;
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
  const all = useMessages(ocStore, sessionId);
  const revert = useSession(ocStore, sessionId)?.revert;
  const paging = usePaging(ocStore, sessionId);
  const hasOlder = paging.cursor !== undefined;

  // A staged revert hides its prompt and what follows until the next
  // prompt drops them or redo brings them back.
  const messages = useMemo(() => visibleMessages(all, revert), [all, revert]);
  const rows = useMemo(() => {
    const out = rowsOf(messages, isRunning === true);
    const boundary = revert?.messageID;
    if (boundary === undefined) return out;
    const count = all.filter(
      (m) => m.type === "user" && m.id >= boundary,
    ).length;
    if (count > 0) out.push({ key: "reverted", kind: "reverted", count });
    return out;
  }, [all, messages, revert, isRunning]);
  // The group the running turn is still adding to.
  const liveKey =
    isRunning === true && rows.at(-1)?.kind === "group"
      ? rows.at(-1)?.key
      : null;

  // Collapsed groups are short, so a page of history can fit on screen and
  // leave nothing to scroll up from. Keep reading older pages until at
  // least two turns show (or the session's start is in).
  const turnsShown = useMemo(
    () => rows.filter((r) => r.kind === "user").length,
    [rows],
  );
  useEffect(() => {
    if (paging.hydrated && hasOlder && !paging.loadingOlder && turnsShown < 2)
      void ocStore.loadOlder(sessionId);
  }, [paging.hydrated, paging.loadingOlder, hasOlder, turnsShown, sessionId]);

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
          <div className="chat-col overflow-x-clip pb-3">
            {renderRow(item, item.key === liveKey, actions, onOpenSession)}
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
