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
  type Query,
  query,
  type SDKAssistantMessage,
  type SDKMessage,
  type SDKPartialAssistantMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  EffortLevel,
  EventDelta,
  ImageAttachment,
  ToolCallDetail,
} from "@sidecodeapp/protocol";
import {
  attachOutputToDetail,
  buildDetailFromInput,
  extractText,
  summaryFor,
  toolResultBlock,
  toolUseBlock,
} from "../messages/tool-detail.js";
import {
  type AsyncMessageInput,
  createAsyncMessageInput,
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
  /**
   * `"create"` → SDK creates a new session at `runtime.sessionId` (passed
   * via `options.sessionId`). `cwd` MUST be provided.
   * `"resume"` → SDK loads existing JSONL via `options.resume`.
   *
   * Decision (existence check via `getSessionInfo`) lives in the router's
   * sendPrompt handler — see project_session_replay_model memory and
   * router.ts for why.
   */
  mode: "create" | "resume";
  /**
   * Working directory for the SDK process. REQUIRED when mode="create"
   * (new session needs a cwd to root in). Ignored when mode="resume" —
   * SDK uses the persisted cwd from the existing session.
   */
  cwd?: string;
  /** Model + effort picker selection from the iOS input bar.
   *
   *  Only applied when this call ACTUALLY spawns the SDK query — i.e.
   *  the first ensureSessionLoop for a runtime. Subsequent calls are
   *  idempotent no-ops and ignore these options. To change the model
   *  on an already-running query, callers use `runtime.query.setModel(...)`
   *  directly (see router's sendPrompt handler).
   *
   *  No equivalent mid-session knob exists for effort — SDK exposes
   *  `setModel` but no `setEffort` (sdk.d.ts:2138 + 1512 confirmed). V0
   *  accepts the limitation: effort changes take effect at the next
   *  daemon restart of the runtime. */
  model?: string;
  effort?: EffortLevel;
  /** Test seam: override the SDK's `query()` factory. */
  queryFactory?: typeof query;
}

/**
 * Idempotent. First call: creates the input channel, spawns the SDK
 * query in streaming-input mode (resume or create per `options.mode`),
 * and starts the consumer loop in the background. Subsequent calls:
 * returns the existing loop promise without touching `runtime.query`
 * or `runtime.inputChannel`.
 *
 * The loop promise resolves when:
 *   - `runtime.query.close()` is called (F3's daemon shutdown)
 *   - `runtime.inputChannel.end()` is called and the SDK drains naturally
 *   - the SDK iterator throws — caught here and surfaced as a
 *     `turn_failed` EventDelta into the runtime buffer (slice G3)
 */
export function ensureSessionLoop(
  runtime: SessionRuntime<EventDelta>,
  options: SessionLoopOptions,
): Promise<void> {
  if (runtime.loopPromise) return runtime.loopPromise;

  const channel = createAsyncMessageInput<SDKUserMessage>();
  runtime.inputChannel = channel;

  const factory = options.queryFactory ?? query;
  // V0 has no approval UI on iOS — every tool call must auto-approve or
  // the iOS user sees nothing happen. SDK requires BOTH `permissionMode:
  // "bypassPermissions"` AND `allowDangerouslySkipPermissions: true`
  // (sdk.d.ts:1469,1485) to truly skip the gate; setting only one isn't
  // enough. Equivalent to claude CLI's `--dangerously-skip-permissions`
  // flag. Revisit when V0.5+ adds an approval-sheet on iOS.
  const bypassFlags = {
    permissionMode: "bypassPermissions" as const,
    allowDangerouslySkipPermissions: true as const,
  };
  // SDK requires sessionId XOR resume — they're mutually exclusive
  // (sdk.d.ts:1538-1540 — "Cannot be used with continue or resume unless
  // forkSession is also set"). We use sessionId for new sessions (so the
  // SDK adopts our client-supplied UUID) and resume for existing ones.
  //
  // `model` / `effort` are spread in only when set — omitting the keys
  // lets the SDK fall through to its own defaults (which honor whatever
  // the user's account / Desktop settings prefer). Per Anthropic SDK
  // contract, `effort` is fixed at query() creation and has no mid-
  // session setter; `model` can also change via `query.setModel` later.
  const modelEffortOptions: { model?: string; effort?: EffortLevel } = {};
  if (options.model !== undefined) modelEffortOptions.model = options.model;
  if (options.effort !== undefined) modelEffortOptions.effort = options.effort;
  const sdkOptions =
    options.mode === "create"
      ? {
          ...bypassFlags,
          ...modelEffortOptions,
          sessionId: runtime.sessionId,
          includePartialMessages: true as const,
          cwd: options.cwd,
        }
      : {
          ...bypassFlags,
          ...modelEffortOptions,
          resume: runtime.sessionId,
          includePartialMessages: true as const,
          cwd: options.cwd,
        };
  const q: Query = factory({
    prompt: channel.iterable,
    options: sdkOptions,
  });
  // Query satisfies RuntimeQueryHandle structurally (interrupt + close).
  runtime.query = q;

  const loopPromise = (async () => {
    const state = newStreamingState();
    try {
      for await (const msg of q) {
        handleSdkMessage(runtime, state, msg);
      }
    } catch (err) {
      // Surface the SDK error as a `turn_failed` so iOS can render it
      // instead of seeing an unexplained gap in the stream.
      runtime.addEvent({
        kind: "turn_failed",
        error: err instanceof Error ? err.message : String(err),
      });
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
 * `ensureSessionLoop` must have been called first — throws otherwise.
 *
 * Emits TWO EventDeltas synchronously into the runtime buffer BEFORE
 * the prompt hits the channel:
 *
 *   1. `append { user_message }` — the SDK iterator NEVER echoes the
 *      user's prompt back (only assistant + tool_result envelopes), so
 *      without this iOS would never see its own message in the live
 *      stream until the next cold-load read the settled JSONL. Daemon
 *      synthesizes the append so iOS can render purely from event
 *      stream — no client-side optimistic state needed.
 *
 *   2. `turn_started` — flips the iOS "thinking…" indicator immediately
 *      (before SDK roundtrip + Claude's first byte; ~200-800ms gap).
 *
 * The user_message uuid we assign here matches the SDKUserMessage.uuid
 * we push to the channel, so SDK's JSONL write uses the same id (per
 * Paseo's pattern at claude-agent.ts:2298). Settled-from-JSONL and
 * live-from-buffer therefore resolve to the same id — no divergence.
 */
export function pushPrompt(
  runtime: SessionRuntime<EventDelta>,
  text: string,
  images?: readonly ImageAttachment[],
): void {
  const channel = runtime.inputChannel;
  if (channel === null) {
    throw new Error(
      `pushPrompt: session ${runtime.sessionId} has no active loop — call ensureSessionLoop first`,
    );
  }
  const userMsgUuid = randomUUID();
  runtime.addEvent({
    kind: "append",
    item: {
      type: "user_message",
      uuid: userMsgUuid,
      text,
      images: images && images.length > 0 ? [...images] : undefined,
    },
  });
  runtime.addEvent({ kind: "turn_started" });
  channel.push(buildUserMessage(runtime.sessionId, text, userMsgUuid, images));
}

function buildUserMessage(
  sessionId: string,
  text: string,
  uuid: string,
  images?: readonly ImageAttachment[],
): SDKUserMessage {
  // SDK content blocks: image(s) prepended before text — matches Claude
  // Code's own paste flow ordering (`array<image,text>` per probe), so
  // the model sees the visual first then the question. Empty text is
  // allowed when only images were sent (skip text block in that case
  // so we don't feed the model an empty string).
  const content: Array<
    | { type: "text"; text: string }
    | {
        type: "image";
        source: { type: "base64"; media_type: string; data: string };
      }
  > = [];
  if (images && images.length > 0) {
    for (const img of images) {
      content.push({
        type: "image",
        source: { type: "base64", media_type: img.mediaType, data: img.data },
      });
    }
  }
  if (text.length > 0) {
    content.push({ type: "text", text });
  }
  return {
    type: "user",
    message: {
      role: "user",
      content,
    },
    parent_tool_use_id: null,
    uuid,
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
  } else if (msg.type === "result") {
    handleResultEnvelope(runtime, msg);
  }
  // Others ignored for V0.
}

/**
 * Anthropic SDK fires one `result` envelope at the end of every turn,
 * shaped as a discriminated union on `subtype` (sdk.d.ts:3155):
 *   - `SDKResultSuccess` (subtype: 'success') — `result: string` carries
 *     the final assistant output text
 *   - `SDKResultError` (subtype: 'error_during_execution' |
 *     'error_max_turns' | 'error_max_budget_usd' |
 *     'error_max_structured_output_retries') — `errors: string[]` carries
 *     the failure reasons (NOT `result`)
 *
 * We must dispatch on subtype so iOS sees `turn_failed` (red banner) for
 * the error case rather than a deceptive `turn_completed` followed by a
 * second `turn_failed` from the catch block (the original bug observed
 * when "No conversation found with session ID" fired before cwd was
 * plumbed through).
 *
 * Usage stats are best-effort: SDK shape uses snake_case. Parse
 * defensively — missing fields become `undefined`.
 */
function handleResultEnvelope(
  runtime: SessionRuntime<EventDelta>,
  msg: SDKMessage,
): void {
  const r = msg as unknown as Record<string, unknown>;
  const rawUsage = r.usage as Record<string, unknown> | undefined;
  const usage = rawUsage
    ? {
        inputTokens: numberOrUndef(rawUsage.input_tokens),
        outputTokens: numberOrUndef(rawUsage.output_tokens),
        cacheReadInputTokens: numberOrUndef(rawUsage.cache_read_input_tokens),
        cacheCreationInputTokens: numberOrUndef(
          rawUsage.cache_creation_input_tokens,
        ),
      }
    : undefined;

  if (r.subtype === "success") {
    runtime.addEvent({ kind: "turn_completed", usage });
    return;
  }
  // Any non-"success" subtype is an error variant. Pull the
  // `errors: string[]` payload; fall back to the subtype name if absent.
  const errors = Array.isArray(r.errors)
    ? (r.errors as unknown[]).filter((e): e is string => typeof e === "string")
    : [];
  const message =
    errors.length > 0
      ? errors.join("\n")
      : `SDK ${String(r.subtype ?? "error")}`;
  runtime.addEvent({ kind: "turn_failed", error: message });
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
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
