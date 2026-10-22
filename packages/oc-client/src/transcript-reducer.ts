/**
 * Live-turn transcript reducer over opencode 2's own projection rows.
 *
 * Rows are `SessionMessageInfo` — the shape `message.list` returns and the
 * official GUI renders. This reducer folds only the *streaming* subset of
 * session events so a running turn looks alive between two reads of the
 * projection: step / text / reasoning / tool lifecycle, retries, and the
 * user inbox. Everything else (compaction, revert, agent/model switches,
 * shells, instruction updates, message edits) is settled by re-reading the
 * projection tail — see `STREAMING_EVENT_TYPES` and the transcript
 * collection. Once a turn ends the server's projection replaces whatever
 * this reducer built, so its only job is to be right *during* a turn.
 *
 * Ported case by case from `handleEvent` in
 * `packages/client/src/solid/data.ts` on anomalyco/opencode `v2.1.2` (MIT),
 * rewritten as immutable updates: untouched rows keep their identity, so a
 * `!==` check is the whole diff for the collection mirror.
 */

import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantText,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client";
import type { OcEvent, OcEventOf } from "./events.ts";

export type TranscriptRows = readonly SessionMessageInfo[];

/** `evt_*` → `msg_*`: events that materialize a message reuse their id. */
export function messageIDFromEvent(eventID: string): string {
  return eventID.replace(/^evt_/, "msg_");
}

/** Events this reducer folds locally. */
export const STREAMING_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.inbox.enqueued",
  "session.inbox.delivered",
  "session.inbox.cancelled",
  "session.synthetic",
  "session.instructions.updated",
  "session.step.started",
  "session.step.streamed",
  "session.step.ended",
  "session.step.failed",
  "session.text.started",
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.started",
  "session.reasoning.delta",
  "session.reasoning.ended",
  "session.tool.input.started",
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.called",
  "session.tool.progress",
  "session.tool.success",
  "session.tool.failed",
  "session.retry.scheduled",
]);

/** Turn boundaries: the collection re-reads the projection tail on these. */
export const TURN_END_EVENT_TYPES: ReadonlySet<string> = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

function indexOf(rows: TranscriptRows, id: string): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.id === id) return i;
  }
  return -1;
}

function replaceAt(
  rows: TranscriptRows,
  index: number,
  next: SessionMessageInfo,
): TranscriptRows {
  if (rows[index] === next) return rows;
  const copy = rows.slice();
  copy[index] = next;
  return copy;
}

function append(
  rows: TranscriptRows,
  item: SessionMessageInfo,
): TranscriptRows {
  if (indexOf(rows, item.id) >= 0) return rows;
  return [...rows, item];
}

/** Insert, or replace a row with the same id (an optimistic guess) in place. */
function upsert(
  rows: TranscriptRows,
  item: SessionMessageInfo,
): TranscriptRows {
  const index = indexOf(rows, item.id);
  return index < 0 ? [...rows, item] : replaceAt(rows, index, item);
}

function editAssistant(
  rows: TranscriptRows,
  messageID: string,
  fn: (assistant: SessionMessageAssistant) => SessionMessageAssistant,
): TranscriptRows {
  const index = indexOf(rows, messageID);
  const item = index < 0 ? undefined : rows[index];
  if (item?.type !== "assistant") return rows;
  return replaceAt(rows, index, fn(item));
}

type Content = SessionMessageAssistant["content"][number];

/** Replace the last content item matching `pick` (the streaming target). */
function editLastContent<T extends Content>(
  assistant: SessionMessageAssistant,
  pick: (item: Content) => item is T,
  fn: (item: T) => T,
): SessionMessageAssistant {
  for (let i = assistant.content.length - 1; i >= 0; i -= 1) {
    const item = assistant.content[i] as Content;
    if (!pick(item)) continue;
    const next = fn(item);
    if (next === item) return assistant;
    const content = assistant.content.slice();
    content[i] = next;
    return { ...assistant, content };
  }
  return assistant;
}

const isText = (c: Content): c is SessionMessageAssistantText =>
  c.type === "text";
const isOpenReasoning = (c: Content): c is SessionMessageAssistantReasoning =>
  c.type === "reasoning" && !c.time?.completed;
const isToolWithID =
  (id: string) =>
  (c: Content): c is SessionMessageAssistantTool =>
    c.type === "tool" && c.id === id;

function editText(
  rows: TranscriptRows,
  messageID: string,
  fn: (text: SessionMessageAssistantText) => SessionMessageAssistantText,
): TranscriptRows {
  return editAssistant(rows, messageID, (a) => editLastContent(a, isText, fn));
}

function editReasoning(
  rows: TranscriptRows,
  messageID: string,
  fn: (
    reasoning: SessionMessageAssistantReasoning,
  ) => SessionMessageAssistantReasoning,
): TranscriptRows {
  return editAssistant(rows, messageID, (a) =>
    editLastContent(a, isOpenReasoning, fn),
  );
}

function editTool(
  rows: TranscriptRows,
  messageID: string,
  toolID: string,
  fn: (tool: SessionMessageAssistantTool) => SessionMessageAssistantTool,
): TranscriptRows {
  return editAssistant(rows, messageID, (a) =>
    editLastContent(a, isToolWithID(toolID), fn),
  );
}

function activeAssistantIndex(rows: TranscriptRows): number {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const item = rows[i];
    if (item?.type === "assistant" && !item.time.completed) return i;
  }
  return -1;
}

/**
 * Fold one bus event into the rows. Returns the same array when the event
 * is not for this reducer or changes nothing. Events addressed to another
 * session must be filtered by the caller.
 */
export function applyTranscriptEvent(
  rows: TranscriptRows,
  event: OcEvent,
): TranscriptRows {
  switch (event.type) {
    case "session.inbox.enqueued": {
      const { item, inboxID } = event.data;
      if (item.type === "user") {
        return upsert(rows, {
          id: inboxID,
          type: "user",
          text: item.payload.text,
          ...(item.payload.files !== undefined
            ? { files: item.payload.files }
            : {}),
          ...(item.payload.agents !== undefined
            ? { agents: item.payload.agents }
            : {}),
          ...(item.payload.skills !== undefined
            ? { skills: item.payload.skills }
            : {}),
          ...(item.payload.metadata !== undefined
            ? { metadata: item.payload.metadata }
            : {}),
          time: { created: event.created },
        });
      }
      if (item.type === "synthetic") {
        return upsert(rows, {
          id: inboxID,
          type: "synthetic",
          text: item.payload.text,
          ...(item.payload.description !== undefined
            ? { description: item.payload.description }
            : {}),
          time: { created: event.created },
        });
      }
      return rows;
    }
    case "session.inbox.delivered": {
      // Delivery moves the input to the tail with its delivery time — a
      // queued prompt lands where the turn actually consumed it.
      const index = indexOf(rows, event.data.inboxID);
      const existing = index < 0 ? undefined : rows[index];
      if (existing === undefined) return rows;
      if (existing.type !== "user" && existing.type !== "synthetic")
        return rows;
      const moved = {
        ...existing,
        time: { ...existing.time, created: event.created },
      };
      const copy = rows.slice();
      copy.splice(index, 1);
      copy.push(moved);
      return copy;
    }
    case "session.inbox.cancelled": {
      const index = indexOf(rows, event.data.inboxID);
      if (index < 0) return rows;
      const copy = rows.slice();
      copy.splice(index, 1);
      return copy;
    }
    case "session.synthetic":
      return append(rows, {
        id: messageIDFromEvent(event.id),
        type: "synthetic",
        text: event.data.text,
        ...(event.data.description !== undefined
          ? { description: event.data.description }
          : {}),
        ...(event.data.metadata !== undefined
          ? { metadata: event.data.metadata }
          : {}),
        time: { created: event.created },
      });
    case "session.instructions.updated": {
      // Mirrors the projector: baselines and empty deltas carry no text
      // and produce no transcript message.
      const text = event.data.text;
      if (text === undefined) return rows;
      return append(rows, {
        id: messageIDFromEvent(event.id),
        type: "system",
        text,
        description: `Instructions updated: ${Object.keys(event.data.delta).join(", ")}`,
        ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
        time: { created: event.created },
      });
    }
    case "session.step.started":
      return stepStarted(rows, event);
    case "session.step.streamed":
      return editAssistant(rows, event.data.assistantMessageID, (a) => ({
        ...a,
        time: { ...a.time, streamed: event.created },
      }));
    case "session.step.ended":
      return editAssistant(rows, event.data.assistantMessageID, (a) => ({
        ...a,
        time: { ...a.time, completed: event.created },
        finish: event.data.finish,
        rawFinish: event.data.rawFinish,
        native: event.data.native,
        cost: event.data.cost,
        tokens: event.data.tokens,
        ...(event.data.snapshot !== undefined
          ? { snapshot: { ...a.snapshot, end: event.data.snapshot } }
          : {}),
      }));
    case "session.step.failed":
      return editAssistant(rows, event.data.assistantMessageID, (a) => ({
        ...a,
        time: { ...a.time, completed: event.created },
        finish: event.data.finish ?? "error",
        rawFinish: event.data.rawFinish,
        native: event.data.native,
        error: event.data.error,
        retry: undefined,
        ...(event.data.cost !== undefined && event.data.tokens !== undefined
          ? { cost: event.data.cost, tokens: event.data.tokens }
          : {}),
      }));
    case "session.text.started":
      return editAssistant(rows, event.data.assistantMessageID, (a) => ({
        ...a,
        content: [...a.content, { type: "text", text: "" }],
      }));
    case "session.text.delta":
      return editText(rows, event.data.assistantMessageID, (t) => ({
        ...t,
        text: t.text + event.data.delta,
      }));
    case "session.text.ended":
      return editText(rows, event.data.assistantMessageID, (t) => ({
        ...t,
        text: event.data.text,
      }));
    case "session.reasoning.started":
      return editAssistant(rows, event.data.assistantMessageID, (a) => ({
        ...a,
        content: [
          ...a.content,
          {
            type: "reasoning",
            text: "",
            ...(event.data.native !== undefined
              ? { native: event.data.native }
              : {}),
            time: { created: event.created },
          },
        ],
      }));
    case "session.reasoning.delta":
      return editReasoning(rows, event.data.assistantMessageID, (r) => ({
        ...r,
        text: r.text + event.data.delta,
      }));
    case "session.reasoning.ended":
      return editReasoning(rows, event.data.assistantMessageID, (r) => ({
        ...r,
        text: event.data.text,
        time: {
          created: r.time?.created ?? event.created,
          completed: event.created,
        },
        ...(event.data.native !== undefined
          ? { native: event.data.native }
          : {}),
      }));
    case "session.tool.input.started":
      return editAssistant(rows, event.data.assistantMessageID, (a) => ({
        ...a,
        content: [
          ...a.content,
          {
            type: "tool",
            id: event.data.id,
            name: event.data.name,
            time: { created: event.created },
            state: { status: "streaming", input: "" },
          },
        ],
      }));
    case "session.tool.input.delta":
      return editTool(
        rows,
        event.data.assistantMessageID,
        event.data.id,
        (tool) =>
          tool.state.status === "streaming"
            ? {
                ...tool,
                state: {
                  ...tool.state,
                  input: tool.state.input + event.data.delta,
                },
              }
            : tool,
      );
    case "session.tool.input.ended":
      return editTool(
        rows,
        event.data.assistantMessageID,
        event.data.id,
        (tool) =>
          tool.state.status === "streaming"
            ? { ...tool, state: { ...tool.state, input: event.data.text } }
            : tool,
      );
    case "session.tool.called":
      return editTool(
        rows,
        event.data.assistantMessageID,
        event.data.id,
        (tool) => ({
          ...tool,
          time: { ...tool.time, ran: event.created },
          executed: event.data.executed,
          ...(event.data.native !== undefined
            ? { native: event.data.native }
            : {}),
          state: { status: "running", input: event.data.input, metadata: {} },
        }),
      );
    case "session.tool.progress":
      return editTool(
        rows,
        event.data.assistantMessageID,
        event.data.id,
        (tool) =>
          tool.state.status === "running"
            ? {
                ...tool,
                state: { ...tool.state, metadata: event.data.metadata },
              }
            : tool,
      );
    case "session.tool.success":
      return editTool(
        rows,
        event.data.assistantMessageID,
        event.data.id,
        (tool) => {
          if (tool.state.status !== "running") return tool;
          return {
            ...tool,
            state: {
              status: "completed",
              input: tool.state.input,
              ...(event.data.metadata !== undefined
                ? { metadata: event.data.metadata }
                : {}),
              content: [...event.data.content],
            },
            executed: event.data.executed || tool.executed === true,
            ...(event.data.native !== undefined
              ? { native: { ...tool.native, ...event.data.native } }
              : {}),
            time: { ...tool.time, completed: event.created },
          };
        },
      );
    case "session.tool.failed":
      return editTool(
        rows,
        event.data.assistantMessageID,
        event.data.id,
        (tool) => {
          if (
            tool.state.status !== "streaming" &&
            tool.state.status !== "running"
          )
            return tool;
          return {
            ...tool,
            state: {
              status: "error",
              error: event.data.error,
              input:
                typeof tool.state.input === "string" ? {} : tool.state.input,
              ...(event.data.metadata !== undefined
                ? { metadata: event.data.metadata }
                : {}),
              ...(event.data.content !== undefined
                ? { content: event.data.content }
                : {}),
            },
            executed: event.data.executed || tool.executed === true,
            ...(event.data.native !== undefined
              ? { native: { ...tool.native, ...event.data.native } }
              : {}),
            time: { ...tool.time, completed: event.created },
          };
        },
      );
    case "session.retry.scheduled":
      return editAssistant(rows, event.data.assistantMessageID, (a) => ({
        ...a,
        retry: {
          attempt: event.data.attempt,
          at: event.data.at,
          error: event.data.error,
        },
      }));
    default:
      return rows;
  }
}

function stepStarted(
  rows: TranscriptRows,
  event: OcEventOf<"session.step.started">,
): TranscriptRows {
  const { assistantMessageID } = event.data;
  const index = indexOf(rows, assistantMessageID);
  const existing = index < 0 ? undefined : rows[index];
  if (existing?.type === "assistant") {
    // A retried step reopens the same assistant message.
    return replaceAt(rows, index, {
      ...existing,
      agent: event.data.agent,
      model: event.data.model,
      retry: undefined,
      error: undefined,
      finish: undefined,
      rawFinish: undefined,
      native: undefined,
      time: { created: event.data.started },
      ...(event.data.snapshot !== undefined
        ? { snapshot: { ...existing.snapshot, start: event.data.snapshot } }
        : {}),
    });
  }
  let next = rows;
  const activeIndex = activeAssistantIndex(rows);
  if (activeIndex >= 0) {
    const active = rows[activeIndex] as SessionMessageAssistant;
    next = replaceAt(rows, activeIndex, {
      ...active,
      retry: undefined,
      time: { ...active.time, completed: event.created },
    });
  }
  return append(next, {
    id: assistantMessageID,
    type: "assistant",
    agent: event.data.agent,
    model: event.data.model,
    ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
    content: [],
    ...(event.data.snapshot !== undefined
      ? { snapshot: { start: event.data.snapshot } }
      : {}),
    time: { created: event.data.started },
  });
}

/**
 * Merge a freshly read projection page into the rows: server rows replace
 * local rows with the same id, unknown server rows are appended in server
 * order, local-only rows (e.g. an input admitted after the read) stay.
 */
export function mergeProjection(
  rows: TranscriptRows,
  fetched: readonly SessionMessageInfo[],
): TranscriptRows {
  if (fetched.length === 0) return rows;
  const byId = new Map(fetched.map((m) => [m.id, m]));
  const next: SessionMessageInfo[] = rows.map((row) => byId.get(row.id) ?? row);
  const present = new Set(rows.map((r) => r.id));
  for (const m of fetched) if (!present.has(m.id)) next.push(m);
  return next;
}
