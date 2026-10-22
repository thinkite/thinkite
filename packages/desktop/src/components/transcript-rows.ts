import type { ModelRef, SessionMessageInfo } from "@thinkite/oc-client";

// The transcript's row model: opencode's messages turned into the rows the
// list renders. Kept apart from the view so it can be tested on recorded
// transcripts.

export type AssistantMessage = Extract<
  SessionMessageInfo,
  { type: "assistant" }
>;
type Part = AssistantMessage["content"][number];
export type ReasoningPart = Extract<Part, { type: "reasoning" }>;
export type ToolPart = Extract<Part, { type: "tool" }>;

/** One line inside a tool group: a tool call, or a stretch of thinking. */
export type GroupItem =
  | { key: string; kind: "tool"; tool: ToolPart }
  | { key: string; kind: "reasoning"; part: ReasoningPart };

export interface UserAttachment {
  name: string;
  mime: string;
  /** `data:` URI of the file. */
  src: string;
}

/** What the line under a turn's last text says. */
export interface ReplyMeta {
  /** The model (and reasoning variant) that wrote the text. */
  model: ModelRef;
  /** Prompt to the turn's last finished step; absent when unknown. */
  durationMs?: number;
}

export type TranscriptRow =
  | {
      key: string;
      kind: "user";
      messageId: string;
      text: string;
      created: number;
      /** Files sent inline (pasted, dropped); @-mentioned ones are in the text. */
      attachments: UserAttachment[];
    }
  | { key: string; kind: "text"; text: string; meta?: ReplyMeta }
  | { key: string; kind: "group"; items: GroupItem[] }
  | { key: string; kind: "tool"; tool: ToolPart }
  /** A subagent's run: its own line, opening the subagent's session. */
  | { key: string; kind: "agent"; tool: ToolPart }
  | { key: string; kind: "note"; text: string; tone: "quiet" | "danger" }
  /** Below the last row while a revert hides `count` prompts. */
  | { key: string; kind: "reverted"; count: number };

/** "12s", "1m 3s", "2h 5m". */
export function duration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The session a subagent call runs in, once the service has made it. */
export function agentSessionOf(tool: ToolPart): string | undefined {
  if (tool.state.status !== "running" && tool.state.status !== "completed")
    return undefined;
  const id = tool.state.metadata?.sessionID;
  return typeof id === "string" ? id : undefined;
}

/** A tool's name as opencode's GUI titles it (`toolTitle` in session-ui). */
export function toolTitle(name: string): string {
  const titles: Record<string, string> = {
    read: "Read",
    list: "List",
    glob: "Glob",
    grep: "Grep",
    browser: "Browser",
    webfetch: "Webfetch",
    websearch: "Web Search",
    subagent: "Agent",
    task: "Agent",
    shell: "Shell",
    bash: "Shell",
    execute: "Execute",
    edit: "Edit",
    write: "Write",
    patch: "Patch",
    question: "Questions",
    skill: "Skill",
  };
  return titles[name] ?? name;
}

/**
 * A group's summary, as opencode words it: "Used 3 Read, Grep, Glob" —
 * the number of tool calls and their distinct titles — or "Used 2 Thoughts"
 * for a group that only thought.
 */
export function groupLabel(items: readonly GroupItem[]): string {
  const tools = items.flatMap((i) => (i.kind === "tool" ? [i.tool] : []));
  if (tools.length > 0) {
    const titles = [...new Set(tools.map((t) => toolTitle(t.name)))];
    return `Used ${tools.length} ${titles.join(", ")}`;
  }
  const thoughts = items.length;
  return `Used ${thoughts} ${thoughts === 1 ? "Thought" : "Thoughts"}`;
}

/**
 * Rows the way opencode desktop's default ("compact") timeline lays them
 * out: the agent's text stays in the open, and every run of tool calls and
 * thinking between two pieces of text stacks into one collapsed "Used N …"
 * row — across the turn's steps too, since a step boundary is not text.
 * Text, notes and the next prompt end a run. A subagent stands on its own
 * (opencode's "separate" placement), as does a finished question (while it
 * waits, its card replaces the composer); the todo list is not shown, as
 * in opencode.
 *
 * Like opencode, a turn's last text gets a line with its model and how
 * long the turn took, once the turn is over: every turn but the last, and
 * the last too unless `running`.
 */
export function rowsOf(
  messages: readonly SessionMessageInfo[],
  running = false,
): TranscriptRow[] {
  const out: TranscriptRow[] = [];
  // The turn being read: when its prompt was sent (unknown when the page
  // starts mid-turn), its latest text row and the latest step to finish.
  let turn: {
    started?: number;
    text?: { index: number; model: ModelRef };
    completed?: number;
  } = {};
  const endTurn = () => {
    const text = turn.text;
    const row = text && out[text.index];
    if (text !== undefined && row?.kind === "text") {
      const { started, completed } = turn;
      out[text.index] = {
        ...row,
        meta: {
          model: text.model,
          ...(started !== undefined &&
          completed !== undefined &&
          completed >= started
            ? { durationMs: completed - started }
            : {}),
        },
      };
    }
    turn = {};
  };
  let group: GroupItem[] = [];
  const close = () => {
    const first = group[0];
    if (first !== undefined)
      out.push({ key: `group:${first.key}`, kind: "group", items: group });
    group = [];
  };
  const push = (row: TranscriptRow) => {
    close();
    out.push(row);
  };
  const note = (
    key: string,
    text: string,
    tone: "quiet" | "danger" = "quiet",
  ) => push({ key, kind: "note", text, tone });

  messages.forEach((message, index) => {
    switch (message.type) {
      case "user":
        endTurn();
        turn.started = message.time.created;
        push({
          key: message.id,
          kind: "user",
          messageId: message.id,
          text: message.text,
          created: message.time.created,
          attachments: (message.files ?? [])
            .filter((f) => f.mention === undefined)
            .map((f, i) => ({
              name: f.name ?? `attachment-${i + 1}`,
              mime: f.mime,
              src: `data:${f.mime};base64,${f.data}`,
            })),
        });
        break;
      case "assistant":
        message.content.forEach((part, i) => {
          const key = `${message.id}:${i}`;
          if (part.type === "text") {
            if (part.text.trim() !== "") {
              push({ key, kind: "text", text: part.text });
              turn.text = { index: out.length - 1, model: message.model };
            }
          } else if (part.type === "reasoning") {
            if (part.text.trim() !== "")
              group.push({ key, kind: "reasoning", part });
          } else if (part.name === "subagent" || part.name === "task") {
            push({ key: `tool:${part.id}`, kind: "agent", tool: part });
          } else if (part.name === "todowrite") {
            // opencode keeps the todo list out of the timeline.
          } else if (
            part.name === "question" &&
            part.state.status !== "error"
          ) {
            if (part.state.status === "completed")
              push({ key: `tool:${part.id}`, kind: "tool", tool: part });
          } else {
            group.push({ key: `tool:${part.id}`, kind: "tool", tool: part });
          }
        });
        if (message.time.completed !== undefined)
          turn.completed = Math.max(
            turn.completed ?? 0,
            message.time.completed,
          );
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
        if (previous?.type === "assistant" && previous.error !== undefined)
          break;
        note(message.id, `Failed: ${message.error?.message ?? ""}`, "danger");
        break;
      }
      // Agent and model switches, skills and the rest have nothing to show.
      default:
        break;
    }
  });
  close();
  if (!running) endTurn();
  return out;
}
