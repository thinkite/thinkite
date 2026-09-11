/**
 * Pure mapping from opencode v2 `session.next.*` events to the Thinkite wire
 * shapes (`TimelineItem` / `EventDelta` / `TurnUsage`).
 *
 * Two counterparts, mirroring the Claude host's split:
 *   - `normalizeOpencodeHistory` — cold start from the durable event log
 *     (`GET history` / stream replay), the counterpart of `normalize()`.
 *   - `mapOpencodeLiveEvent` — one live event → `EventDelta | null`, the
 *     counterpart of the run-query consumer loop.
 *
 * Both share one tool mapping table (`buildOpencodeDetail`). Field names
 * were verified against `../opencode/packages/opencode/src/tool/*.ts`
 * (opencode uses camelCase: `filePath`, `oldString`… — NOT the Claude
 * snake_case the shared detail builders take, so inputs are translated).
 * Divergences found while verifying:
 *   - `read`/`edit` take `filePath`, but the model emits `path` in
 *     practice (observed live on read + edit calls); both are accepted
 *     (same for `write`, defensively).
 *   - `read` success carries an empty `content[]` with the file text in
 *     `structured.content`; that fallback is built into the extractor.
 *   - `grep` has no `output_mode` (it has `include` instead); its output
 *     lists content matches, so the detail is pinned to mode `"content"`.
 *   - `webfetch` has no `prompt` (it has `format`); the detail prompt is
 *     left empty.
 *   - `task` has no `model` override; the detail model stays undefined.
 *   - `question` options use `multiple`, mapped to `multiSelect`.
 *
 * Turn boundaries: one user prompt drives MULTIPLE steps (observed: a
 * two-tool turn emits step.ended `finish:"tool-calls"` mid-turn and
 * `finish:"stop"` at the end), so `step.ended` is NOT a turn end — the
 * session loop detects idleness via `activeSessions()` polling and emits
 * `turn_completed` itself, reading the stashed `lastUsage`. `step.failed`
 * is terminal for the turn (an interrupt also lands here with
 * `"Provider turn interrupted"`; the loop swallows it when its
 * `interrupted` flag is set, mirroring run-query).
 */

import type {
  EventDelta,
  TimelineItem,
  ToolCallDetail,
  ToolCallItem,
  TurnUsage,
} from "@thinkite/protocol";
import {
  attachOutputToDetail,
  buildDetailFromInput,
  extractText,
  summaryFor,
} from "../messages/tool-detail.ts";
import type { OpencodeDurableEvent, OpencodeLiveEvent } from "./client.ts";

/** Minimal shape both durable and live envelopes satisfy. */
export interface OpencodeEventLike {
  type: string;
  data: Record<string, unknown>;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

// ─── Tool mapping table (opencode id → Thinkite detail) ──────────────

interface QuestionOption {
  label: string;
  description: string;
}

/**
 * Build a typed `ToolCallDetail` from an opencode tool id + raw input
 * object, reusing the shared detail builders (single source of truth for
 * diffs/summaries with the Claude host). Unknown tools fall through to
 * `buildDetailFromInput`'s default branch, which keeps the opencode name
 * in an `unknown` detail.
 */
export function buildOpencodeDetail(
  tool: string,
  rawInput: unknown,
): ToolCallDetail {
  const input = record(rawInput);
  switch (tool) {
    case "bash":
      return buildDetailFromInput("Bash", { command: input.command });
    case "edit":
      // Like `read`, the model emits `path` here in practice.
      return buildDetailFromInput("Edit", {
        file_path: input.filePath ?? input.path,
        old_string: input.oldString,
        new_string: input.newString,
        replace_all: input.replaceAll,
      });
    case "read": {
      // The model sometimes emits `path` instead of `filePath` (observed
      // live on a read call); accept both.
      const filePath = input.filePath ?? input.path;
      return buildDetailFromInput("Read", {
        file_path: filePath,
        offset: input.offset,
        limit: input.limit,
      });
    }
    case "write":
      return buildDetailFromInput("Write", {
        file_path: input.filePath ?? input.path,
        content: input.content,
      });
    case "glob":
      return buildDetailFromInput("Glob", {
        pattern: input.pattern,
        path: input.path,
      });
    case "grep":
      return buildDetailFromInput("Grep", {
        pattern: input.pattern,
        path: input.path,
        output_mode: "content",
      });
    case "webfetch":
      return buildDetailFromInput("WebFetch", {
        url: input.url,
        prompt: "",
      });
    case "websearch":
      return buildDetailFromInput("WebSearch", { query: input.query });
    case "task":
      return buildDetailFromInput("Agent", {
        description: input.description,
        prompt: input.prompt,
        subagent_type: input.subagent_type,
      });
    case "question": {
      const questions = Array.isArray(input.questions)
        ? input.questions.map((q) => {
            const r = record(q);
            const options = Array.isArray(r.options)
              ? r.options.map((o) => {
                  const or = record(o);
                  return {
                    label: str(or.label) ?? "",
                    description: str(or.description) ?? "",
                  } satisfies QuestionOption;
                })
              : [];
            return {
              question: str(r.question) ?? "",
              header: str(r.header) ?? "",
              multiSelect: r.multiple === true,
              options,
            };
          })
        : [];
      return buildDetailFromInput("AskUserQuestion", { questions });
    }
    default:
      return buildDetailFromInput(tool, rawInput);
  }
}

// ─── Tool output + usage extractors ──────────────────────────────────

/** Pull display text out of a `tool.success` / `tool.failed` event body. */
export function opencodeToolOutputText(data: Record<string, unknown>): string {
  // Success: `content: [{type:"text",text}…]` (file parts skipped by
  // extractText, same as the Claude host). Some tools (read) report an
  // empty content array with the payload in `structured.content` instead.
  if (Array.isArray(data.content)) {
    const text = extractText(data.content);
    if (text.length > 0) return text;
    const structured = str(record(data.structured).content);
    return structured ?? "";
  }
  // Failure: `error: {type, message}` (+ `result.value` echo).
  const message = str(record(data.error).message);
  if (message !== undefined) return message;
  const value = record(data.result).value;
  return typeof value === "string" ? value : "";
}

/** `step.ended.tokens` → `TurnUsage`. `reasoning` has no protocol slot. */
export function opencodeTurnUsage(
  data: Record<string, unknown>,
): TurnUsage | undefined {
  const tokens = record(data.tokens);
  if (Object.keys(tokens).length === 0) return undefined;
  const cache = record(tokens.cache);
  const usage: TurnUsage = {};
  const input = num(tokens.input);
  const output = num(tokens.output);
  const read = num(cache.read);
  const write = num(cache.write);
  if (input !== undefined) usage.inputTokens = input;
  if (output !== undefined) usage.outputTokens = output;
  if (read !== undefined) usage.cacheReadInputTokens = read;
  if (write !== undefined) usage.cacheCreationInputTokens = write;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Stable assistant-message uuid shared by the cold and live paths. */
export function opencodeTextUuid(
  assistantMessageID: string,
  textID: string,
): string {
  return `${assistantMessageID}:${textID}`;
}

// ─── Cold path: durable log → TimelineItem[] ─────────────────────────

export interface OpencodeHistory {
  items: TimelineItem[];
  /** From the last `step.ended` carrying tokens, if any. */
  usage?: TurnUsage;
}

/**
 * Fold a durable `session.next.*` log into timeline items. Idempotent over
 * the admission pair: `prompt.admitted` and `prompted` share the messageID,
 * so the first one wins and the echo is skipped.
 */
export function normalizeOpencodeHistory(
  events: readonly OpencodeDurableEvent[],
): OpencodeHistory {
  const items: TimelineItem[] = [];
  const seenUserMessages = new Set<string>();
  const pendingTools = new Map<string, ToolCallItem>();
  let usage: TurnUsage | undefined;

  for (const ev of events) {
    const data = ev.data ?? {};
    switch (ev.type) {
      case "session.next.prompt.admitted":
      case "session.next.prompted": {
        const messageID = str(data.messageID);
        if (messageID === undefined || seenUserMessages.has(messageID)) break;
        seenUserMessages.add(messageID);
        const text = str(record(data.prompt).text) ?? "";
        if (text.length === 0) break;
        items.push({ type: "user_message", uuid: messageID, text });
        break;
      }
      case "session.next.text.ended": {
        const assistantMessageID = str(data.assistantMessageID);
        const textID = str(data.textID);
        const text = str(data.text);
        if (assistantMessageID === undefined || textID === undefined) break;
        if (text === undefined || text.length === 0) break;
        items.push({
          type: "assistant_message",
          uuid: opencodeTextUuid(assistantMessageID, textID),
          text,
        });
        break;
      }
      case "session.next.tool.called": {
        const callID = str(data.callID);
        if (callID === undefined) break;
        const tool = str(data.tool) ?? "unknown";
        const detail = buildOpencodeDetail(tool, data.input);
        const item: ToolCallItem = {
          type: "tool_call",
          callId: callID,
          name: tool,
          summary: summaryFor(detail, tool),
          // Settled log: default completed, a later result may flip to
          // failed (mirrors normalize()'s pairing).
          status: "completed",
          error: null,
          detail,
        };
        items.push(item);
        pendingTools.set(callID, item);
        break;
      }
      case "session.next.tool.success":
      case "session.next.tool.failed": {
        const callID = str(data.callID);
        const target =
          callID !== undefined ? pendingTools.get(callID) : undefined;
        if (target === undefined) break; // orphan result — skip
        const outputText = opencodeToolOutputText(data);
        const failed = ev.type === "session.next.tool.failed";
        target.status = failed ? "failed" : "completed";
        target.error = failed ? outputText : null;
        attachOutputToDetail(target.detail, outputText);
        pendingTools.delete(callID as string);
        break;
      }
      case "session.next.step.ended": {
        const u = opencodeTurnUsage(data);
        if (u !== undefined) usage = u;
        break;
      }
      case "session.next.compaction.ended": {
        // opencode exposes no token counts on compaction — the divider
        // carries 0/0 (see module docstring + stage-1 report).
        const messageID = str(data.messageID);
        const reason = data.reason === "auto" ? "auto" : "manual";
        if (messageID === undefined) break;
        items.push({
          type: "compact_divider",
          uuid: messageID,
          trigger: reason,
          preTokens: 0,
          postTokens: 0,
        });
        break;
      }
      default:
        // step.started/failed, text.started, tool.input.*, reasoning.*,
        // context.updated, synthetic, agent/model switched, moved,
        // retried, revert.*, shell.* — no transcript row.
        break;
    }
  }

  return usage !== undefined ? { items, usage } : { items };
}

// ─── Live path: one event → EventDelta | null ────────────────────────

export interface OpencodeLiveState {
  /** textID → assistant-message uuid (for patch routing). */
  textUuid: Map<string, string>;
  /** textID → text accumulated from deltas (for end-reconcile). */
  textSeen: Map<string, string>;
  /** callID → running detail (for result patching). */
  tools: Map<string, ToolCallDetail>;
  /** Prompt messageIDs already emitted (admitted/prompted dedupe). */
  seenPrompts: Set<string>;
  /** Latest `step.ended` usage; the session loop reads it at turn end. */
  lastUsage?: TurnUsage;
}

export function createOpencodeLiveState(): OpencodeLiveState {
  return {
    textUuid: new Map(),
    textSeen: new Map(),
    tools: new Map(),
    seenPrompts: new Set(),
  };
}

export interface OpencodeLiveOptions {
  /**
   * Maps opencode prompt messageIDs to client-supplied user-message uuids
   * (the iOS optimistic insert id). When the admitted event for a mapped
   * message arrives, the append reuses the client's uuid so it dedupes by
   * key instead of rendering a double bubble.
   */
  userMessageUuids?: Map<string, string>;
}

/**
 * Streaming counterpart of the run-query consumer loop. Text: `started` →
 * empty append, live-only `delta` (global bus) → `patch_text`, `ended`
 * reconciles any gap (missed deltas while detached) with a suffix patch.
 * The session loop — not this function — decides turn ends (idleness) and
 * swallows `step.failed` while its `interrupted` flag is set.
 */
export function mapOpencodeLiveEvent(
  ev: OpencodeEventLike,
  state: OpencodeLiveState,
  opts: OpencodeLiveOptions = {},
): EventDelta | null {
  const data = ev.data ?? {};
  switch (ev.type) {
    case "session.next.prompt.admitted":
    case "session.next.prompted": {
      const messageID = str(data.messageID);
      if (messageID === undefined || state.seenPrompts.has(messageID)) {
        return null;
      }
      state.seenPrompts.add(messageID);
      const text = str(record(data.prompt).text) ?? "";
      if (text.length === 0) return null;
      return {
        kind: "append",
        item: {
          type: "user_message",
          uuid: opts.userMessageUuids?.get(messageID) ?? messageID,
          text,
        },
      };
    }
    case "session.next.text.started": {
      const assistantMessageID = str(data.assistantMessageID);
      const textID = str(data.textID);
      if (assistantMessageID === undefined || textID === undefined) return null;
      // The global bus (deltas) and the durable stream are unordered
      // relative to each other: a delta may arrive first and self-heal the
      // append. A late `started` must not duplicate it or clobber text.
      if (state.textUuid.has(textID)) return null;
      const uuid = opencodeTextUuid(assistantMessageID, textID);
      state.textUuid.set(textID, uuid);
      state.textSeen.set(textID, "");
      return {
        kind: "append",
        item: { type: "assistant_message", uuid, text: "" },
      };
    }
    case "session.next.text.delta": {
      const textID = str(data.textID);
      const delta = str(data.delta);
      if (textID === undefined || delta === undefined || delta.length === 0) {
        return null;
      }
      const uuid = state.textUuid.get(textID);
      if (uuid === undefined) {
        // Attached mid-text (missed `started`): self-heal with an append
        // carrying this fragment so the text still renders.
        const assistantMessageID = str(data.assistantMessageID) ?? "";
        const healed = opencodeTextUuid(assistantMessageID, textID);
        state.textUuid.set(textID, healed);
        state.textSeen.set(textID, delta);
        return {
          kind: "append",
          item: { type: "assistant_message", uuid: healed, text: delta },
        };
      }
      state.textSeen.set(textID, (state.textSeen.get(textID) ?? "") + delta);
      return { kind: "patch_text", uuid, deltaText: delta };
    }
    case "session.next.text.ended": {
      const assistantMessageID = str(data.assistantMessageID);
      const textID = str(data.textID);
      const text = str(data.text);
      if (assistantMessageID === undefined || textID === undefined) return null;
      if (text === undefined) return null;
      const uuid =
        state.textUuid.get(textID) ??
        opencodeTextUuid(assistantMessageID, textID);
      state.textUuid.set(textID, uuid);
      const seen = state.textSeen.get(textID) ?? "";
      state.textSeen.set(textID, text);
      if (text === seen) return null;
      // Suffix after the longest common prefix: covers both the normal
      // "missed tail deltas" case and a diverged prefix without duplication.
      let prefix = 0;
      while (
        prefix < seen.length &&
        prefix < text.length &&
        seen[prefix] === text[prefix]
      ) {
        prefix += 1;
      }
      const remainder = text.slice(prefix);
      if (remainder.length === 0) return null;
      // When nothing was seen at all this is the whole text, not a patch
      // onto an existing empty append — but the `started` append (empty)
      // already exists in both paths, so patch_text still applies.
      return { kind: "patch_text", uuid, deltaText: remainder };
    }
    case "session.next.tool.called": {
      const callID = str(data.callID);
      if (callID === undefined) return null;
      if (state.tools.has(callID)) return null;
      const tool = str(data.tool) ?? "unknown";
      const detail = buildOpencodeDetail(tool, data.input);
      state.tools.set(callID, detail);
      return {
        kind: "append",
        item: {
          type: "tool_call",
          callId: callID,
          name: tool,
          summary: summaryFor(detail, tool),
          status: "running",
          error: null,
          detail,
        },
      };
    }
    case "session.next.tool.success":
    case "session.next.tool.failed": {
      const callID = str(data.callID);
      const detail = callID !== undefined ? state.tools.get(callID) : undefined;
      if (callID === undefined || detail === undefined) return null;
      const outputText = opencodeToolOutputText(data);
      attachOutputToDetail(detail, outputText);
      state.tools.delete(callID);
      const failed = ev.type === "session.next.tool.failed";
      return {
        kind: "patch_tool_call",
        callId: callID,
        status: failed ? "failed" : "completed",
        error: failed ? outputText : null,
        detail: { ...detail },
      };
    }
    case "session.next.step.ended": {
      const u = opencodeTurnUsage(data);
      if (u !== undefined) state.lastUsage = u;
      return null;
    }
    case "session.next.step.failed": {
      const message = str(record(data.error).message) ?? "opencode step failed";
      return { kind: "turn_failed", error: message };
    }
    case "session.next.compaction.started":
      return { kind: "compact_started" };
    case "session.next.compaction.ended": {
      const messageID = str(data.messageID);
      if (messageID === undefined) return null;
      return {
        kind: "compact_applied",
        trigger: data.reason === "auto" ? "auto" : "manual",
        preTokens: 0,
        postTokens: 0,
        uuid: messageID,
      };
    }
    default:
      return null;
  }
}

export type { OpencodeDurableEvent, OpencodeLiveEvent };
