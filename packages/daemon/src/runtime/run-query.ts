/**
 * Drive the SDK's `query()` in **streaming-input mode** — one persistent
 * subprocess per session, fed user prompts via an async channel. Each
 * emitted SDK message becomes an `EventDelta` pushed into the runtime's
 * ring buffer.
 *
 * Why streaming-input (vs single-shot string `prompt: string`):
 *   - SDK's `interrupt()` only works in streaming mode (per
 *     sdk.d.ts:2018-2027). Single-shot prompts would leave F3's "stop"
 *     button dead.
 *   - One subprocess per session → no 1-2s respawn + context reload per
 *     turn.
 *   - Matches Paseo's pattern (claude-agent.ts:2109-2113).
 *
 * Public API:
 *   - `ensureSessionLoop(runtime, options)` — idempotent; lazy-creates
 *     the channel, query, and consumer loop on first call. Returns the
 *     loop's promise (resolves when query exits via close / error /
 *     natural end). Subsequent calls return the existing promise.
 *   - `pushPrompt(runtime, text)` — pushes a user message into the
 *     channel. Throws if no loop is running yet.
 *
 * Consumer-loop behavior — what each SDK message becomes:
 *   - `stream_event` (with `includePartialMessages: true` set):
 *       - `message_start` → remember Anthropic message.id
 *       - `content_block_start (text)` → `append { assistant_message }`
 *         with empty text under synthetic uuid `${msgId}:${blockIndex}`
 *       - `content_block_delta (text_delta)` → `patch_text` against
 *         that synthetic uuid
 *       - `content_block_*` for tool_use / `input_json_delta` → IGNORED.
 *         V0 waits for the `assistant` envelope (which carries the full
 *         input) and emits the running tool_call atomically. Partial-JSON
 *         input streaming is deferred (see project_session_replay_model
 *         memory and Paseo's claude-agent.ts:3918 for V0.5+ adoption).
 *
 *   - `assistant` envelope: each `tool_use` block (deduped by call id)
 *     becomes `append { tool_call, status: "running", detail }`.
 *
 *   - `user` envelope: each `tool_result` block patches the matching
 *     pending tool_call → `patch_tool_call { status, error, detail }`.
 *
 *   - everything else (system / status / hook / result / replay): ignored.
 *
 * Identifier divergence between live and settled state is documented in
 * the protocol's `eventDelta` doc — synthetic `${msgId}:${idx}` for live
 * assistant_message uuids vs envelope uuid for cold-start. They never
 * coexist in the iOS view, so the divergence is acceptable for V0.
 */

import { randomUUID } from "node:crypto";
import {
  query,
  type Query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { EventDelta, ToolCallDetail } from "@sidecodeapp/protocol";
import {
  attachOutputToDetail,
  buildDetailFromInput,
  extractText,
  summaryFor,
  toolResultBlock,
  toolUseBlock,
} from "../messages/tool-detail.js";
import {
  createAsyncMessageInput,
  type AsyncMessageInput,
} from "./async-message-input.js";
import type { SessionRuntime } from "./session-runtime.js";

// ─── Streaming state (per turn — actually per persistent loop) ─────────

interface StreamingState {
  /** Anthropic message.id of the message currently being streamed (between message_start/stop). */
  currentMessageId: string | null;
  /** messageId → blockIndex → synthetic assistant_message uuid. */
  textBlockUuids: Map<string, Map<number, string>>;
  /** tool_use_ids we've emitted append for. Prevents dups when assistant envelopes split per block. */
  appendedToolUseIds: Set<string>;
  /** tool_use_id → detail (kept around so tool_result patching reuses the typed shape). */
  pendingTools: Map<string, ToolCallDetail>;
}

function newStreamingState(): StreamingState {
  return {
    currentMessageId: null,
    textBlockUuids: new Map(),
    appendedToolUseIds: new Set(),
    pendingTools: new Map(),
  };
}

// ─── Public API ─────────────────────────────────────────────────────────

export interface SessionLoopOptions {
  cwd?: string;
  /** Test seam: override the SDK's `query()` factory. */
  queryFactory?: typeof query;
}

/**
 * Idempotent. First call: creates the input channel, spawns the SDK
 * query in streaming-input mode, and starts the consumer loop in the
 * background. Subsequent calls: returns the existing loop promise
 * without touching `runtime.query` or `runtime.inputChannel`.
 *
 * The loop promise resolves when:
 *   - someone calls `runtime.query.close()` (F3's daemon shutdown)
 *   - `runtime.inputChannel.end()` is called and the SDK drains naturally
 *   - the SDK iterator throws (the error is caught and swallowed for V0;
 *     slice G will replace this with a turn_failed delta emission)
 */
export function ensureSessionLoop(
  runtime: SessionRuntime<EventDelta>,
  options: SessionLoopOptions = {},
): Promise<void> {
  if (runtime.loopPromise) return runtime.loopPromise;

  const channel = createAsyncMessageInput<SDKUserMessage>();
  runtime.inputChannel = channel;

  const factory = options.queryFactory ?? query;
  const q: Query = factory({
    prompt: channel.iterable,
    options: {
      resume: runtime.sessionId,
      includePartialMessages: true,
      cwd: options.cwd,
    },
  });
  // Query satisfies RuntimeQueryHandle structurally (interrupt + close).
  runtime.query = q;

  const loopPromise = (async () => {
    const state = newStreamingState();
    try {
      for await (const msg of q) {
        handleSdkMessage(runtime, state, msg);
      }
    } catch {
      // V0: swallow. Slice G will replace this with a turn_failed
      // EventDelta emission so iOS can render the failure.
    } finally {
      runtime.query = null;
      runtime.inputChannel = null;
      runtime.loopPromise = null;
    }
  })();
  runtime.loopPromise = loopPromise;
  return loopPromise;
}

/**
 * Push a user prompt into the channel feeding the active SDK query.
 * `ensureSessionLoop` must have been called first — F2 throws otherwise
 * to surface the misuse loud and early. Slice G will wrap both into a
 * single `sendPromptRpc` so router callers don't need to remember the
 * order.
 */
export function pushPrompt(
  runtime: SessionRuntime<EventDelta>,
  text: string,
): void {
  const channel = runtime.inputChannel;
  if (channel === null) {
    throw new Error(
      `pushPrompt: session ${runtime.sessionId} has no active loop — call ensureSessionLoop first`,
    );
  }
  channel.push(buildUserMessage(runtime.sessionId, text));
}

function buildUserMessage(sessionId: string, text: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  } as unknown as SDKUserMessage;
}

// ─── SDK message dispatch ───────────────────────────────────────────────

function handleSdkMessage(
  runtime: SessionRuntime<EventDelta>,
  state: StreamingState,
  msg: SDKMessage,
): void {
  if (msg.type === "stream_event") {
    handleStreamEvent(runtime, state, msg);
  } else if (msg.type === "assistant") {
    handleAssistantEnvelope(runtime, state, msg);
  } else if (msg.type === "user") {
    handleUserEnvelope(runtime, state, msg);
  }
  // Others ignored for V0.
}

function handleStreamEvent(
  runtime: SessionRuntime<EventDelta>,
  state: StreamingState,
  msg: SDKPartialAssistantMessage,
): void {
  // SDK types `event` as the upstream Beta union — go through `unknown`
  // and narrow defensively rather than importing every Beta type into
  // our runtime.
  const event = msg.event as unknown as Record<string, unknown>;
  const eventType = typeof event.type === "string" ? event.type : null;

  if (eventType === "message_start") {
    const message = event.message as Record<string, unknown> | undefined;
    const messageId = typeof message?.id === "string" ? message.id : null;
    state.currentMessageId = messageId;
    return;
  }

  if (eventType === "message_stop") {
    state.currentMessageId = null;
    return;
  }

  if (eventType === "content_block_start") {
    const block = event.content_block as Record<string, unknown> | undefined;
    const index = typeof event.index === "number" ? event.index : null;
    if (block?.type === "text" && index !== null && state.currentMessageId) {
      const synthUuid = `${state.currentMessageId}:${index}`;
      let perMsg = state.textBlockUuids.get(state.currentMessageId);
      if (!perMsg) {
        perMsg = new Map();
        state.textBlockUuids.set(state.currentMessageId, perMsg);
      }
      perMsg.set(index, synthUuid);
      runtime.addEvent({
        kind: "append",
        item: { type: "assistant_message", uuid: synthUuid, text: "" },
      });
    }
    // tool_use content_block_start ignored — handled atomically when the
    // `assistant` envelope arrives with full input.
    return;
  }

  if (eventType === "content_block_delta") {
    const delta = event.delta as Record<string, unknown> | undefined;
    const index = typeof event.index === "number" ? event.index : null;
    if (
      delta?.type === "text_delta" &&
      typeof delta.text === "string" &&
      delta.text.length > 0 &&
      index !== null &&
      state.currentMessageId
    ) {
      const uuid = state.textBlockUuids.get(state.currentMessageId)?.get(index);
      if (uuid) {
        runtime.addEvent({
          kind: "patch_text",
          uuid,
          deltaText: delta.text,
        });
      }
    }
    // input_json_delta ignored.
    return;
  }
  // content_block_stop, message_delta: ignored.
}

function handleAssistantEnvelope(
  runtime: SessionRuntime<EventDelta>,
  state: StreamingState,
  msg: SDKAssistantMessage,
): void {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    const parsed = toolUseBlock.safeParse(rawBlock);
    if (!parsed.success) continue;
    const t = parsed.data;
    if (state.appendedToolUseIds.has(t.id)) continue;
    state.appendedToolUseIds.add(t.id);
    const detail = buildDetailFromInput(t.name, t.input);
    state.pendingTools.set(t.id, detail);
    runtime.addEvent({
      kind: "append",
      item: {
        type: "tool_call",
        callId: t.id,
        name: t.name,
        summary: summaryFor(detail, t.name),
        status: "running",
        error: null,
        detail,
      },
    });
  }
}

function handleUserEnvelope(
  runtime: SessionRuntime<EventDelta>,
  state: StreamingState,
  msg: SDKUserMessage,
): void {
  const content = (msg.message as { content?: unknown })?.content;
  if (!Array.isArray(content)) return;
  for (const rawBlock of content) {
    const parsed = toolResultBlock.safeParse(rawBlock);
    if (!parsed.success) continue;
    const t = parsed.data;
    const detail = state.pendingTools.get(t.tool_use_id);
    if (!detail) continue; // orphan tool_result — append happens in assistant envelope, which we may have missed
    const outputText = extractText(t.content);
    attachOutputToDetail(detail, outputText);
    runtime.addEvent({
      kind: "patch_tool_call",
      callId: t.tool_use_id,
      status: t.is_error ? "failed" : "completed",
      error: t.is_error ? outputText : null,
      // Shallow copy so the buffered EventDelta isn't aliased to the
      // pendingTools entry (which we'll drop next anyway, but defensive).
      detail: { ...detail },
    });
    state.pendingTools.delete(t.tool_use_id);
  }
}

// AsyncMessageInput is module-level export only for type clarity in tests
// that need to construct one directly. Production callers use ensureSessionLoop.
export type { AsyncMessageInput };
