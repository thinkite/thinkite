import type { SessionMessageInfo } from "@thinkite/oc-client";

// The transcript's row model: opencode's messages turned into the rows the
// list renders, one turn at a time. Kept apart from the view so it can be
// tested on recorded transcripts.

export type AssistantMessage = Extract<
  SessionMessageInfo,
  { type: "assistant" }
>;
type Part = AssistantMessage["content"][number];
export type ReasoningPart = Extract<Part, { type: "reasoning" }>;
export type ToolPart = Extract<Part, { type: "tool" }>;

export type TranscriptRow =
  | { key: string; kind: "user"; messageId: string; text: string }
  | { key: string; kind: "text"; text: string }
  | { key: string; kind: "reasoning"; part: ReasoningPart }
  | { key: string; kind: "tool"; tool: ToolPart }
  | { key: string; kind: "note"; text: string; tone: "quiet" | "danger" }
  | { key: string; kind: "process"; label: string; rows: TranscriptRow[] };

/** "12s", "1m 3s", "2h 5m". */
export function duration(ms: number): string {
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
export function rowsOf(
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
