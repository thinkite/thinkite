import semver from "semver";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };

export {
  type ChunkEnvelope,
  ChunkReassembler,
  chunkMessage,
  isChunkEnvelope,
} from "./chunking.js";
export {
  dtlsFingerprintTranscript,
  extractDtlsFingerprint,
} from "./sdp-fingerprint.js";

// ─── Protocol version ──────────────────────────────────────────────────────
//
// Single source of truth for "what wire schemas does this side speak."
// The protocol package IS the wire contract, so its semver IS the wire
// version — daemon and iOS both import this same value (whatever's in
// `packages/protocol/package.json`'s `version` field).
//
// Bumping = edit `packages/protocol/package.json` (e.g. `npm version
// patch`). No constant elsewhere to keep in sync; the package.json IS
// the source of truth, both at npm-install time and at runtime.
//
// Compatibility check (`isProtocolCompatible`) also lives in this
// package so the rule travels with the schemas it's protecting.
// Transports just call the helper; they don't reason about semver
// themselves.
//
// Bump policy:
//   - **patch** (0.0.1 → 0.0.2 / 1.2.3 → 1.2.4): additive only — new
//     optional field, new enum case, new whole frame type that older
//     peers harmlessly ignore. Compatible.
//   - **minor** (0.0.x → 0.1.0 during 0.x; 1.0.0 → 1.1.0 post-1.0):
//     0.x minor bump is breaking (npm semver convention for 0.x);
//     ≥1.0 minor bump is additive. The compat helper handles both.
//   - **major** (1.x → 2.0.0): breaking schema change post-1.0.
//   - **pre-release** (`0.5.0-beta.1`): NOT compatible with `0.5.0`
//     per semver convention — pre-releases are explicitly opt-in.
export const PROTOCOL_VERSION: string = pkg.version;

/**
 * True iff a remote peer reporting `remote` speaks a wire-compatible
 * schema set with this build's PROTOCOL_VERSION. Compatible means
 * `remote` satisfies a caret range over PROTOCOL_VERSION:
 *
 *   - `^0.5.7` → compatible with `0.5.x` (any patch), not `0.6.0`
 *   - `^1.2.3` → compatible with `1.x.y` (any minor or patch ≥ 1.2.3)
 *
 * This is npm's standard caret semantics — same rule npm uses to decide
 * which versions satisfy a `^x.y.z` dependency. The semver package
 * handles pre-release tags / build metadata / edge cases correctly,
 * which a hand-rolled major-comparison would miss.
 *
 * Returns `false` on unparseable input (defensive — we'd rather refuse
 * than blunder on with an unknown version that might or might not be
 * compatible).
 */
export function isProtocolCompatible(remote: string): boolean {
  if (!semver.valid(remote) || !semver.valid(PROTOCOL_VERSION)) return false;
  return semver.satisfies(remote, `^${PROTOCOL_VERSION}`, {
    // includePrerelease: false — pre-release versions don't satisfy
    // a caret range over a stable version. This is npm's default and
    // it's the right call: a 1.2.0-beta.1 daemon shouldn't be
    // considered compatible with a 1.0.0 client (the beta may have
    // incompatible schemas mid-development).
    includePrerelease: false,
  });
}

// ─── Pair offer ────────────────────────────────────────────────────────────
//
// The QR carries just enough to wire up signaling + identity-verify the
// daemon. Connection itself is WebRTC: client opens a SignalingClient to
// the room named after `daemonIdentityPublicKey`, daemon's offer arrives
// signed by the corresponding private key, client verifies fpSig against
// the QR-known pubkey, DTLS binds the channel.
//
// Two fields:
//   - `daemonIdentityPublicKey` — base64url ed25519 raw pubkey. Doubles as
//     the signaling room name AND the verification key for the daemon's
//     SDP fingerprint signature. The 16-hex daemon fingerprint is
//     `sha256(pubkey).slice(0,16)` — derived, not transmitted.
//   - `serviceName` — `os.hostname()` snapshot for the iOS confirm UI.
//
// The QR carries no expiry. Admission of an unknown pubkey is gated
// daemon-side by "is the menubar Pair window open" — that flag, not the
// QR, is the authority on "can a fresh client pair right now." A stale
// screenshot is harmless once the window closes.

export const PAIR_OFFER_VERSION = 2;

export const pairOfferFrame = z.object({
  type: z.literal("pair.offer"),
  v: z.number().int(),
  daemonIdentityPublicKey: z.string(), // base64url ed25519 raw pubkey
  serviceName: z.string(),
});

export type PairOfferFrame = z.infer<typeof pairOfferFrame>;

/**
 * On-the-wire pair offer with one-character keys. The QR is the only
 * place this frame ever appears, and every character in the QR payload
 * costs us ~1 module in the rendered grid. Compacting to single letters
 * keeps the QR a couple version steps smaller.
 */
const pairOfferWire = z.object({
  v: z.number().int(),
  k: z.string(), // daemonIdentityPublicKey
  s: z.string(), // serviceName
});
export type PairOfferWire = z.infer<typeof pairOfferWire>;

export function toPairOfferWire(offer: PairOfferFrame): PairOfferWire {
  return { v: offer.v, k: offer.daemonIdentityPublicKey, s: offer.serviceName };
}

export function fromPairOfferWire(wire: unknown): PairOfferFrame {
  const parsed = pairOfferWire.parse(wire);
  return {
    type: "pair.offer",
    v: parsed.v,
    daemonIdentityPublicKey: parsed.k,
    serviceName: parsed.s,
  };
}

/** Encode a pair offer to its QR wire form: base64url of UTF-8 JSON. */
export function encodePairOffer(offer: PairOfferFrame): string {
  const json = JSON.stringify(toPairOfferWire(offer));
  return base64urlEncodeUtf8(json);
}

/** Decode the wire form produced by `encodePairOffer`. */
export function decodePairOfferPayload(payload: string): PairOfferFrame {
  return fromPairOfferWire(JSON.parse(base64urlDecodeUtf8(payload)));
}

function base64urlEncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecodeUtf8(b64: string): string {
  const padded = b64 + "===".slice(0, (4 - (b64.length % 4)) % 4);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ─── Events: daemon → client (server-pushed, no requestId) ─────────────────

export const sessionUpdatedEvent = z.object({
  type: z.literal("session.updated"),
  sessionId: z.string(),
  lastModified: z.number(),
});

export const approvalRequestEvent = z.object({
  type: z.literal("approval.request"),
  sessionId: z.string(),
  requestId: z.string(),
  toolName: z.string(),
  toolUseId: z.string(),
  title: z.string().optional(),
  input: z.unknown(),
});

export const sessionDivergedEvent = z.object({
  type: z.literal("session.diverged"),
  sessionId: z.string(),
  branches: z.array(z.string()).min(2),
});

export const sessionForkedEvent = z.object({
  type: z.literal("session.forked"),
  from: z.string(),
  to: z.string(),
  upToMessageId: z.string(),
});

export const event = z.discriminatedUnion("type", [
  sessionUpdatedEvent,
  approvalRequestEvent,
  sessionDivergedEvent,
  sessionForkedEvent,
]);

export type Event = z.infer<typeof event>;

// ─── Session metadata (display-oriented; daemon → iOS list view) ──────────

export const sessionOrigin = z.enum(["desktop-mirror", "sidecode-created"]);
export type SessionOrigin = z.infer<typeof sessionOrigin>;

/**
 * Lean session record returned by `listSessions`. Field set is what the iOS
 * list view actually renders today; extend conservatively as new screens
 * need more. Distinct from Desktop's on-disk `local_*.json` schema and from
 * the SDK's `SDKSessionInfo` — both have many fields we don't expose to the
 * client.
 */
export const sessionInfo = z.object({
  sessionId: z.string(),
  cwd: z.string(),
  /**
   * Parent project root. Equal to `cwd` for non-fork sessions; differs
   * (points to the original project root) for forks running in worktrees.
   * iOS groups the list by this — without it, each worktree would show
   * up as its own pseudo-project section. Daemon always populates it
   * (falls back to `cwd` when missing on disk).
   */
  originCwd: z.string(),
  lastActivityAt: z.number(),
  origin: sessionOrigin,
  /** CLI session UUID. Required because every code path that ships a session
   *  to iOS — desktop-mirror today, sidecode-created tomorrow — produces it.
   *  iOS uses this to fetch the message transcript via `getMessages`. The
   *  daemon's reader filters out any local_*.json that lacks it. */
  cliSessionId: z.string(),
  title: z.string().optional(),
  /** Raw model string as persisted on disk — e.g. `claude-opus-4-7[1m]`
   *  for Desktop sessions (preserves the `[1m]` 1M-context suffix) or the
   *  SDK alias (`default` / `sonnet` / `haiku`) for sidecode-created
   *  sessions. iOS uses this for equality / picker-selected-state checks
   *  and for sending back to the daemon on next sendPrompt. For display
   *  use `modelLabel` instead. */
  model: z.string().optional(),
  /** Display-formatted version of `model` — e.g. "Opus 4.7 1M" derived
   *  by daemon's `prettyModel`. iOS renders this in session list /
   *  detail header. Optional because not every code path normalizes
   *  (and iOS can fall back to raw `model` when missing). */
  modelLabel: z.string().optional(),
  isArchived: z.boolean().optional(),
});

export type SessionInfo = z.infer<typeof sessionInfo>;

// ─── Timeline items (server-normalized message stream) ────────────────────
//
// Daemon translates raw SDK SessionMessage[] (Anthropic ContentBlock[] inside
// `message`) into a flat TimelineItem[]: one item per assistant text segment,
// one per user text segment, one per paired tool_use+tool_result. iOS just
// renders — no flattening, no tool-pairing on the client.
//
// Field naming: camelCase throughout, even where SDK uses snake_case in INPUT
// shapes (`file_path` → `filePath`, `old_string` → `oldString`). Output shapes
// in SDK are already camelCase (`structuredPatch`, `numLines`).

// ─── Shared content schemas (referenced by both timelineItem + sendPromptCommand) ──

/**
 * Image attachment. V0 accepts only base64 — daemon forwards as-is into
 * Anthropic SDK's `{type:'image', source:{type:'base64', media_type, data}}`
 * content block. Format limited to JPEG/PNG: mobile picker pipeline always
 * compresses to JPEG (Opus 4.7 long edge 2576px), PNG slot exists for
 * future pasted-screenshot path that wants to preserve transparency.
 *
 * Wire size: a single 2576x1448 JPEG q0.85 ≈ 600KB-1MB base64. Chunking
 * protocol (chunking.ts) splits at 60K chars, so a typical image flows
 * as ~10-15 chunks over the DataChannel.
 */
export const imageAttachment = z.object({
  data: z.string(),
  mediaType: z.enum(["image/jpeg", "image/png"]),
});
export type ImageAttachment = z.infer<typeof imageAttachment>;

/**
 * Anthropic API stop_reason — verbatim enum from the SDK.
 * `null` is significant: it indicates the message was interrupted —
 * either the user called `interrupt()` mid-stream, or the SDK shut
 * down before the turn completed. iOS shows a "[stopped]" badge.
 *
 * (`pause_turn` shows up when the model voluntarily yields; `refusal`
 * when it declines to answer. We carry both so UI can theme them
 * differently in V0.5+, though V0 treats anything-non-null as "normal
 * completion" visually.)
 */
export const assistantStopReason = z
  .enum([
    "end_turn",
    "tool_use",
    "max_tokens",
    "stop_sequence",
    "pause_turn",
    "refusal",
    "model_context_window_exceeded",
  ])
  .nullable();
export type AssistantStopReason = z.infer<typeof assistantStopReason>;

export const grepMode = z.enum(["content", "files_with_matches", "count"]);
export type GrepMode = z.infer<typeof grepMode>;

/**
 * Per-tool semantic detail. Each variant is a render hint for iOS — bash/read
 * fence the output for tree-sitter highlight, edit/write surface a unified
 * diff, grep/glob just dump the rg/glob text blob.
 *
 * Reality of the data we work from: `getSessionMessages()` strips the sidecar
 * `toolUseResult` field that Claude Code writes to disk (see normalize.ts).
 * What's left in tool_result is the textual content the model SAW — so we
 * can't rebuild structuredPatch/gitDiff/exitCode/numFiles/etc. on the daemon.
 * Detail variants therefore carry the raw input metadata + a single text
 * `output` blob, and edit/write diffs are computed via jsdiff from input
 * (Edit: old/new; Write: empty/content).
 *
 * `unknown` is the fallback for tools we don't specially-render in V0
 * (WebFetch, WebSearch, Agent, NotebookEdit, MCP*, etc.). iOS renders it as
 * `name` chip + accordion-revealed pretty-printed input + raw output text.
 */
export const toolCallDetail = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("bash"),
    command: z.string(),
    /** Claude-generated active-voice short summary (BashInput.description). */
    description: z.string().optional(),
    /** Combined text output the model saw (stdout+stderr+errors as one blob).
     *  Empty / preview-only when `runInBackground: true` — the real output
     *  lives in `/tasks/{taskId}.output` and is owned by the SDK's
     *  background task subsystem (see V0.5+ background-tasks panel). */
    output: z.string(),
    /** Mirrors SDK input `run_in_background`. Tells the iOS transcript this
     *  bash spawn was fire-and-forget — the row should link to the
     *  Background Tasks panel rather than show its output inline. */
    runInBackground: z.boolean().optional(),
    /** Background task ID (`b3v2ethee`-style 8-char). Parsed out of
     *  tool_result by daemon when `runInBackground:true`. Lets the
     *  transcript row deep-link to the Background Tasks panel entry. */
    taskId: z.string().optional(),
  }),
  z.object({
    type: z.literal("read"),
    filePath: z.string(),
    /** File content as the model saw it (line-number prefix stripped). */
    content: z.string(),
    /** tree-sitter language hint derived from file extension (sidecode-side). */
    language: z.string().optional(),
    offset: z.number().optional(),
    limit: z.number().optional(),
    /** PDF page range, only set for PDF reads. */
    pages: z.string().optional(),
  }),
  z.object({
    type: z.literal("edit"),
    filePath: z.string(),
    oldString: z.string(),
    newString: z.string(),
    replaceAll: z.boolean().optional(),
    /** Unified diff computed by daemon via jsdiff(filePath, oldString, newString). */
    unifiedDiff: z.string(),
  }),
  z.object({
    type: z.literal("write"),
    filePath: z.string(),
    content: z.string(),
    /** Unified diff against empty (treats every Write as "new file"); we can't
     * tell create-vs-update without the sidecar, so we always show all-add. */
    unifiedDiff: z.string(),
  }),
  z.object({
    type: z.literal("grep"),
    pattern: z.string(),
    path: z.string().optional(),
    mode: grepMode,
    /** Raw rg output as the model saw it. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("glob"),
    pattern: z.string(),
    path: z.string().optional(),
    /** Raw glob output (newline-separated paths) as the model saw it. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("agent"),
    /** SDK `Agent.input.subagent_type` — registered subagent name (e.g.
     *  "Explore", "Plan", "general-purpose"). */
    subagentType: z.string(),
    description: z.string(),
    /** Original prompt handed to the subagent. May be long. */
    prompt: z.string(),
    /** Final text the subagent returned to the parent conversation.
     *  Subagent's intermediate tool calls and chain-of-thought are NOT
     *  here — they live in the subagent JSONL and surface via the
     *  Background Tasks panel ("View transcript" link) in V0.5+. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("web_fetch"),
    url: z.string(),
    /** Extraction prompt — describes what to pull from the page. */
    prompt: z.string(),
    /** Lossy-by-design summary the fetch-side small model produced.
     *  Not raw page HTML; see Claude Code docs for WebFetch behavior. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("web_search"),
    query: z.string(),
    /** Returned result titles + URLs as the model saw them. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("task_create"),
    /** SDK does NOT pass taskId in input — daemon parses it out of the
     *  tool_result text ("Created task #N: …"). Required field because
     *  every subsequent TaskUpdate/TaskStop refers to it. */
    taskId: z.string(),
    /** Short label shown in todo lists. */
    subject: z.string(),
    description: z.string().optional(),
    /** Present-progressive form for "in-progress" rendering
     *  ("Installing foo" vs "Install foo"). */
    activeForm: z.string().optional(),
  }),
  z.object({
    type: z.literal("task_update"),
    /** SDK uses `taskId` here (camelCase) — kept verbatim. */
    taskId: z.string(),
    status: z
      .enum(["pending", "in_progress", "completed", "cancelled"])
      .optional(),
    activeForm: z.string().optional(),
  }),
  z.object({
    type: z.literal("task_stop"),
    /** SDK input field is `task_id` (snake_case, inconsistent with
     *  TaskUpdate's camelCase). Daemon normalizes to camelCase here. */
    taskId: z.string(),
  }),
  z.object({
    type: z.literal("ask_user"),
    /** The questions Claude posed. Each may be single- or multi-select. */
    questions: z.array(
      z.object({
        question: z.string(),
        header: z.string(),
        multiSelect: z.boolean(),
        options: z.array(
          z.object({
            label: z.string(),
            description: z.string(),
          }),
        ),
      }),
    ),
    /** User's selected option labels — daemon parses out of tool_result.
     *  Same array order as `questions`; each element is the chosen label
     *  (or comma-joined labels if multiSelect). Undefined while pending. */
    answers: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("schedule_wakeup"),
    /** Seconds from now until Claude re-fires; SDK clamps to [60, 3600]. */
    delaySeconds: z.number(),
    /** Short user-facing reason, shown in transcript + telemetry. */
    reason: z.string(),
    /** Prompt to fire on wake-up — typically a re-invocation of /loop. */
    prompt: z.string(),
  }),
  z.object({
    type: z.literal("monitor"),
    /** Watch command (typically `tail -f X`, `gh pr checks --watch`, etc.). */
    command: z.string(),
    description: z.string().optional(),
    /** Background task ID — same role as bash.taskId. Monitor always
     *  spawns a background task (that's its whole purpose). */
    taskId: z.string().optional(),
    /** Initial output preview / handshake message. The live stream of
     *  output lines flows through the Background Tasks panel, not here. */
    output: z.string(),
  }),
  z.object({
    type: z.literal("unknown"),
    /** Raw SDK tool name so iOS can show "WebFetch" / "Agent" / etc. on the chip. */
    toolName: z.string(),
    input: z.unknown(),
    output: z.string(),
  }),
]);
export type ToolCallDetail = z.infer<typeof toolCallDetail>;

const toolCallItem = z.object({
  type: z.literal("tool_call"),
  /** Mirrors SDK tool_use_id; pairs the call with its result for daemon-side. */
  callId: z.string(),
  /** Raw SDK tool name ("Bash", "Edit", "Read", "WebFetch", ...). */
  name: z.string(),
  /** Daemon-derived chip label (e.g. "src/utils/foo.ts" for Edit, "TODO" for Grep). */
  summary: z.string(),
  /**
   * V0 reads settled JSONL so most tool_calls arrive `completed` or `failed`.
   * `running` is a forward-compat slot for the streaming slice — when we wire
   * partial messages from `query()`, a tool_use without its paired tool_result
   * will surface as `running` until the result lands. Producers in V0 never
   * emit it; UI may still render it as a "no signal yet" placeholder.
   */
  status: z.enum(["completed", "failed", "running"]),
  /** Tool result error text when status="failed", null otherwise. */
  error: z.string().nullable(),
  detail: toolCallDetail,
  /** Reserved extension point — wire-stable when we eventually add fields. */
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ToolCallItem = z.infer<typeof toolCallItem>;

export const timelineItem = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_message"),
    /** SDK SessionMessage uuid for the surrounding message envelope. */
    uuid: z.string(),
    /** Concatenated text from all text content blocks in the message.
     *  May be empty when the user sent only image(s) with no caption. */
    text: z.string(),
    /** Images attached to this user message, in the order they appear
     *  in the SDK content block array. Daemon decodes from
     *  `{type:'image', source:{type:'base64', media_type, data}}` blocks. */
    images: z.array(imageAttachment).optional(),
  }),
  z.object({
    type: z.literal("assistant_message"),
    uuid: z.string(),
    text: z.string(),
    /** Anthropic stop_reason. `null` (vs undefined) is significant —
     *  it indicates the assistant message was interrupted before the
     *  model wrote its own stop_reason. UI shows a "[stopped]" badge
     *  in that case. `undefined` means the daemon didn't have the
     *  field yet (live streaming partial), not the same thing. */
    stopReason: assistantStopReason.optional(),
  }),
  toolCallItem,
]);
export type TimelineItem = z.infer<typeof timelineItem>;

/**
 * Incremental update applied to an iOS-side timeline during a live turn.
 * The daemon's runtime emits these into a per-session ring buffer; the
 * router fans them out to subscribers (slice G). iOS replays buffered
 * deltas to reach the current rendering state.
 *
 * Shape rationale:
 *   - `append` covers any whole new TimelineItem (assistant_message bubble
 *     created from first text chunk; tool_call with status="running" when
 *     a tool_use lands).
 *   - `patch_text` is the hot path during streaming — appended to the most
 *     recent assistant_message item identified by `uuid`.
 *   - `patch_tool_call` flips status (running → completed/failed), sets
 *     error text, and replaces detail with a fresh copy carrying tool_result
 *     output text (slotted into the right per-variant field by the daemon
 *     so iOS doesn't re-implement that logic).
 *
 * Identifier conventions during a live turn:
 *   - assistant_message `uuid`: synthetic `${anthropicMessageId}:${blockIndex}`
 *     (stable across the multiple stream_events for one content block, but
 *     diverges from the JSONL envelope uuid that batch normalize uses on
 *     cold-start). They never coexist in iOS view, so the divergence is OK.
 *   - tool_call `callId`: Anthropic tool_use_id, identical live + settled.
 */
export const eventDelta = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("append"),
    /** Whole TimelineItem to push at the end of the rendered transcript. */
    item: timelineItem,
  }),
  z.object({
    kind: z.literal("patch_text"),
    /** uuid of the assistant_message item to append `deltaText` into. */
    uuid: z.string(),
    deltaText: z.string(),
  }),
  z.object({
    kind: z.literal("patch_tool_call"),
    /** Anthropic tool_use_id of the existing tool_call to update. */
    callId: z.string(),
    /** Terminal status — daemon never patches back to "running". */
    status: z.enum(["completed", "failed"]),
    /** Tool result error text when status="failed", null otherwise. */
    error: z.string().nullable(),
    /** Replacement detail with output slotted into the right field. */
    detail: toolCallDetail,
  }),
  // ─── Turn lifecycle ────────────────────────────────────────────────
  // Bracket each Claude turn so iOS can render "thinking…" / show-stop /
  // hide-stop / failure-toast / canceled-marker without inferring from
  // event timing. Emitted by run-query (turn_started before pushPrompt
  // fans out, turn_completed on `result` envelope, turn_failed in the
  // catch where F2 swallowed errors) and by router's interrupt handler
  // (turn_canceled after query.interrupt() resolves).
  z.object({
    kind: z.literal("turn_started"),
  }),
  z.object({
    kind: z.literal("turn_completed"),
    /** Optional usage stats lifted from the SDK `result` envelope. */
    usage: z
      .object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        cacheReadInputTokens: z.number().optional(),
        cacheCreationInputTokens: z.number().optional(),
      })
      .optional(),
  }),
  z.object({
    kind: z.literal("turn_failed"),
    error: z.string(),
  }),
  z.object({
    kind: z.literal("turn_canceled"),
  }),
]);
export type EventDelta = z.infer<typeof eventDelta>;

// ─── Streaming-session commands (client → daemon) ──────────────────────────
//
// All four request a per-session control action and get a correlated response.
// Live stream events arrive as `eventFrame`s tagged with `sessionId` (no
// requestId) — those are server-initiated, fanned out from the runtime
// to subscribers. ws disconnect is treated as an implicit `unsubscribe-all`
// for that connection (no RPC needed).

export const subscribeCommand = z.object({
  type: z.literal("subscribe"),
  requestId: z.string(),
  sessionId: z.string(),
});

export const subscribeResponse = z.object({
  type: z.literal("subscribe.response"),
  requestId: z.string(),
  sessionId: z.string(),
  /** Settled JSONL state at subscribe time (empty if session has no transcript yet). */
  settled: z.array(timelineItem),
  /** Runtime cursor at subscribe time. iOS may use it for debug/log; live deltas carry their own cursor. */
  cursor: z.number(),
});

export const unsubscribeCommand = z.object({
  type: z.literal("unsubscribe"),
  requestId: z.string(),
  sessionId: z.string(),
});

export const unsubscribeResponse = z.object({
  type: z.literal("unsubscribe.response"),
  requestId: z.string(),
});

// ─── Model picker — list available Claude models for the iOS picker ──────
//
// Daemon serializes its MODEL_METADATA table (skipping `deprecated`
// entries) so iOS doesn't have to ship its own copy — daemon owns the
// source of truth and ships new models as part of each sidecode release.
// iOS does equality on `model` strings against SessionInfo.model and
// sendPromptCommand.model.
//
// `effort` deliberately omitted from this schema (and from sendPrompt /
// setSessionSelection): sidecode V0 trusts Claude's adaptive thinking +
// per-account `Settings.effortLevel` defaults, doesn't expose a per-
// session effort knob. Power users tweak via Desktop `/effort` slash
// command which persists to settings.json; sidecode honors that
// implicitly by not passing `--effort` on its spawned subprocess.

export const modelEntry = z.object({
  /** Raw key as it appears in Desktop session metadata + CLI `--model` flag,
   *  e.g. `"claude-opus-4-7[1m]"`. Mirrors SessionInfo.model so iOS can
   *  equality-check picker selection against session state. */
  model: z.string(),
  /** Human-readable label, e.g. `"Opus 4.7 1M"`. Same value daemon writes
   *  into SessionInfo.modelLabel. */
  displayName: z.string(),
  /** Exactly one entry in a getModels response has this `true`. iOS
   *  bootstraps the picker selection to this when SessionInfo.model is
   *  missing (sidecode-created sessions today). */
  isDefault: z.boolean(),
  /** Optional picker subtitle. */
  description: z.string().optional(),
  /** Context window in tokens. Optional — iOS picker may derive 1M vs 200K
   *  from the `[1m]` suffix when this is absent. */
  contextWindow: z.number().optional(),
});
export type ModelEntry = z.infer<typeof modelEntry>;

export const getModelsCommand = z.object({
  type: z.literal("getModels"),
  requestId: z.string(),
});

export const getModelsResponse = z.object({
  type: z.literal("getModels.response"),
  requestId: z.string(),
  /** Non-deprecated entries from daemon's MODEL_METADATA table, in source
   *  order (current models first). Always non-empty — the daemon's
   *  module-load self-check guarantees at least one isDefault entry. */
  models: z.array(modelEntry),
});

/**
 * Send a user prompt into a session.
 *
 * `cwd` is REQUIRED on the first sendPrompt for a session that doesn't yet
 * have JSONL on disk (= iOS-creating a new session). Daemon checks via
 * SDK's `getSessionInfo(sessionId)`; missing-cwd-for-new-session → daemon
 * replies with `{ type: "error", code: "invalid_message" }`. For resume
 * (session already exists), `cwd` is ignored — SDK uses the persisted cwd.
 *
 * `images` carries base64-encoded image attachments — daemon wraps these
 * into SDK content blocks (`{type:'image', source:{type:'base64', ...}}`)
 * and prepends them to the text block. Empty `text` is allowed when only
 * images are sent. The chunking layer (chunking.ts) splits large image
 * payloads across DataChannel frames; protocol consumers don't see chunks.
 *
 * `model` carries the input-bar picker's current selection, forwarded
 * to the SDK `query()` options on every send (NOT pinned per session —
 * user can switch mid-conversation via `setSessionSelection`). Omitted
 * = use the SDK's default.
 */
export const sendPromptCommand = z.object({
  type: z.literal("sendPrompt"),
  requestId: z.string(),
  sessionId: z.string(),
  text: z.string(),
  cwd: z.string().optional(),
  images: z.array(imageAttachment).optional(),
  model: z.string().optional(),
});

export const sendPromptResponse = z.object({
  type: z.literal("sendPrompt.response"),
  requestId: z.string(),
});

/**
 * Pick-time commit of the input-bar model selection.
 *
 * Fired by iOS the moment the user picks a different model (not
 * bundled with sendPrompt). Daemon applies via a single
 * `applyFlagSettings({ model })` on the live SDK query first, then
 * writes the new model into sidecode metadata if that call succeeds.
 *
 * Omitted model is a no-op (defensive — iOS shouldn't fire this).
 *
 * Errors: daemon replies with `error` (code `internal`) when the
 * control plane apply throws — e.g., model not allowed by the user's
 * account, transient subprocess issue. iOS uses this signal to roll
 * back the optimistic picker update.
 */
export const setSessionSelectionCommand = z.object({
  type: z.literal("setSessionSelection"),
  requestId: z.string(),
  sessionId: z.string(),
  model: z.string().optional(),
});

export const setSessionSelectionResponse = z.object({
  type: z.literal("setSessionSelection.response"),
  requestId: z.string(),
});

/** User pressed "stop" on the live turn. Targets `runtime.query.interrupt()`
 *  — turn ends, session/subprocess stays alive for follow-up prompts. */
export const interruptCommand = z.object({
  type: z.literal("interrupt"),
  requestId: z.string(),
  sessionId: z.string(),
});

export const interruptResponse = z.object({
  type: z.literal("interrupt.response"),
  requestId: z.string(),
});

/**
 * Server-initiated streaming event — one per `runtime.addEvent`. Fanned out
 * to every subscriber on the corresponding session. `cursor` is the
 * runtime's monotonic counter for this event; clients may ignore it in V0.
 */
export const eventFrame = z.object({
  type: z.literal("event"),
  sessionId: z.string(),
  cursor: z.number(),
  delta: eventDelta,
});

export const approveCommand = z.object({
  type: z.literal("approve"),
  requestId: z.string(),
  decision: z.enum(["allow", "deny"]),
  reason: z.string().optional(),
});

export const stopTaskCommand = z.object({
  type: z.literal("stopTask"),
  sessionId: z.string(),
});

// ─── Request/response commands (correlated by requestId) ───────────────────

export const listSessionsCommand = z.object({
  type: z.literal("listSessions"),
  requestId: z.string(),
  dir: z.string().optional(),
});

export const listSessionsResponse = z.object({
  type: z.literal("listSessions.response"),
  requestId: z.string(),
  sessions: z.array(sessionInfo),
});

export const deleteSessionCommand = z.object({
  type: z.literal("deleteSession"),
  requestId: z.string(),
  sessionId: z.string(),
});

export const deleteSessionResponse = z.object({
  type: z.literal("deleteSession.response"),
  requestId: z.string(),
});

/**
 * Open a session in Claude Desktop via the `claude://resume` deep link.
 *
 * V0 callers pass only `cliSessionId` (sidecode-created sessions whose Desktop
 * mirror does not yet exist). `desktopLocalSessionId` is reserved for V0.5+
 * "navigate to existing Desktop session" — see project_continue_on_desktop.md
 * for the dedup-via-prefix-strip rationale.
 */
export const continueOnDesktopCommand = z.object({
  type: z.literal("continueOnDesktop"),
  requestId: z.string(),
  cliSessionId: z.string(),
  desktopLocalSessionId: z.string().optional(),
});

export const continueOnDesktopResponse = z.object({
  type: z.literal("continueOnDesktop.response"),
  requestId: z.string(),
  ok: z.boolean(),
  /** Human-readable error when ok=false (e.g. `open` exited non-zero, Desktop missing). */
  error: z.string().optional(),
});

/**
 * Read a session's full message transcript. Backed by the SDK's
 * `getSessionMessages`, which parses the JSONL at
 * `~/.claude/projects/<projectKey>/<cliSessionId>.jsonl`.
 *
 * V0 returns the whole transcript — no pagination. For typical Claude Code
 * sessions this is hundreds of messages at most, well within FlatList's
 * virtualized rendering envelope. Add `limit`/`offset` later (non-breaking)
 * if profiling shows it matters.
 *
 * `cwd` is intentionally optional. Empirically the JSONL location for fork
 * sessions in worktrees isn't deterministic — sometimes it lives at the
 * worktree's project key, sometimes at originCwd's. Omitting `cwd` makes
 * the SDK do an all-projects scan (~20 stat calls, sub-ms on SSD), which
 * is robust. Future optimization: pass `cwd` and `originCwd` as hints,
 * daemon tries each before falling back to scan.
 */
export const getMessagesCommand = z.object({
  type: z.literal("getMessages"),
  requestId: z.string(),
  cliSessionId: z.string(),
  cwd: z.string().optional(),
});

export const getMessagesResponse = z.object({
  type: z.literal("getMessages.response"),
  requestId: z.string(),
  /**
   * Server-normalized timeline (assistant text / user text / paired tool_call).
   * Replaces the previous raw `messages: SessionMessage[]` shape on
   * 2026-05-02 — see Slice D normalization commit.
   */
  items: z.array(timelineItem),
});

// ─── Git status subscription (workspace info bar) ─────────────────────────
//
// Push-based per-cwd live status. Client opens a subscription on a cwd
// (resolved iOS-side from `sessionInfo`), gets an initial snapshot in the
// response, and then receives `gitStatus` events whenever the daemon's
// per-cwd watcher detects a change. Closing the DataChannel implicitly
// unsubscribes; an explicit `unsubscribeGitStatus` releases the watcher
// ref-count early so the daemon can dispose its fs.watch handles.

export const gitStatus = z.object({
  /** False when `cwd` isn't a git repository. Numeric fields are zero,
   *  `branch` is null, `project` is still filled with basename(cwd). */
  isRepo: z.boolean(),
  /** `path.basename(cwd)`. Daemon's heuristic — what the user sees in
   *  Finder, no `package.json` peek, works for any language. */
  project: z.string(),
  /** Null when not a repo OR in detached-HEAD state. */
  branch: z.string().nullable(),
  ahead: z.number().int().nonnegative(),
  behind: z.number().int().nonnegative(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  isDirty: z.boolean(),
});
export type GitStatus = z.infer<typeof gitStatus>;

export const subscribeGitStatusCommand = z.object({
  type: z.literal("subscribeGitStatus"),
  requestId: z.string(),
  cwd: z.string(),
});

export const subscribeGitStatusResponse = z.object({
  type: z.literal("subscribeGitStatus.response"),
  requestId: z.string(),
  cwd: z.string(),
  /** Snapshot at subscribe time — saves a follow-up roundtrip before the
   *  iOS bar can render. Live deltas follow via `gitStatus` events. */
  status: gitStatus,
});

export const unsubscribeGitStatusCommand = z.object({
  type: z.literal("unsubscribeGitStatus"),
  requestId: z.string(),
  cwd: z.string(),
});

export const unsubscribeGitStatusResponse = z.object({
  type: z.literal("unsubscribeGitStatus.response"),
  requestId: z.string(),
});

/** Server-initiated push. `cwd` is the routing key — iOS may subscribe
 *  to multiple cwds (e.g. listing pages) and route by this field. */
export const gitStatusEvent = z.object({
  type: z.literal("gitStatus"),
  cwd: z.string(),
  status: gitStatus,
});

// ─── Filesystem browser (cwd picker + V0.5+ file picker) ───────────────────
//
// One workhorse RPC + one bootstrap RPC. The workhorse `listDirectory`
// reads a single directory level (Finder-style hierarchical browser);
// the bootstrap `getFilesystemRoots` returns the home/desktop/documents
// paths iOS needs as starting points + a recents list aggregated from
// session history (since iOS doesn't know the daemon machine's HOME).
//
// File-picker readiness: `includeFiles` defaults to false for V0's
// folder-only picker; flipping it surfaces files too. `directoryEntry`
// carries optional size + modifiedAt so a future file picker can show
// metadata without a schema bump. To skip the per-file stat cost in
// the V0 folder-only path, the daemon's handler ONLY stats entries
// when `includeFiles === true`.

export const directoryEntry = z.object({
  /** Last path segment, e.g. "src" or "package.json". */
  name: z.string(),
  /** Absolute path. */
  path: z.string(),
  kind: z.enum(["directory", "file"]),
  /** Size in bytes. Populated only when the response includes files
   *  AND the daemon could stat the entry. Absent otherwise. */
  size: z.number().optional(),
  /** ISO 8601 mtime. Populated alongside `size` only. */
  modifiedAt: z.string().optional(),
});
export type DirectoryEntry = z.infer<typeof directoryEntry>;

export const listDirectoryCommand = z.object({
  type: z.literal("listDirectory"),
  requestId: z.string(),
  /** Absolute path, or "~" / "~/..." (server expands to HOME). Anything
   *  else (relative paths, "~user") is treated as-is and likely errors. */
  path: z.string(),
  /** Include files in the response. Default false — V0 folder picker
   *  needs directories only, skipping files lets the daemon skip the
   *  per-entry stat loop entirely. */
  includeFiles: z.boolean().optional(),
  /** Include dotfile / dot-directory entries (.git, .config, etc.).
   *  Default false. */
  includeHidden: z.boolean().optional(),
});

export const listDirectoryResponse = z.object({
  type: z.literal("listDirectory.response"),
  requestId: z.string(),
  /** Echoed canonical absolute path of the listed dir (post-"~"-expansion). */
  path: z.string(),
  /** Parent absolute path for breadcrumb / up-nav. Null when at the
   *  filesystem root ("/"). */
  parent: z.string().nullable(),
  /** Sorted by daemon: directories first, then files; alphabetical
   *  within each group (case-insensitive). iOS can render straight
   *  through without re-sorting. */
  entries: z.array(directoryEntry),
});

/** Recent cwd entry — union of Desktop session cwds and sidecode session
 *  cwds, filtered to only paths that still exist on disk (stale cwds
 *  from deleted/moved projects are dropped). */
export const recentCwd = z.object({
  path: z.string(),
  /** ISO 8601 timestamp of the most recent session activity at this cwd. */
  lastUsedAt: z.string(),
});

export const getFilesystemRootsCommand = z.object({
  type: z.literal("getFilesystemRoots"),
  requestId: z.string(),
});

export const getFilesystemRootsResponse = z.object({
  type: z.literal("getFilesystemRoots.response"),
  requestId: z.string(),
  /** Daemon machine's HOME directory absolute path (e.g.
   *  "/Users/yangyueqian"). Always populated — every OS has $HOME. */
  home: z.string(),
  /** `${home}/Desktop` if it exists on disk. Optional because Desktop
   *  is not universal (Linux headless servers / non-standard XDG
   *  locales lack it); macOS always has it. */
  desktop: z.string().optional(),
  /** `${home}/Documents` if it exists on disk. Same optionality
   *  reasoning as `desktop`. */
  documents: z.string().optional(),
  /** Recent project cwds, sorted by lastUsedAt desc, deduped and
   *  filtered to existing paths. Max 10. */
  recentCwds: z.array(recentCwd),
});

// ─── Health + error ────────────────────────────────────────────────────────

export const pingFrame = z.object({
  type: z.literal("ping"),
  t: z.number(),
});

export const pongFrame = z.object({
  type: z.literal("pong"),
  t: z.number(),
  echoT: z.number(),
});

export const errorFrame = z.object({
  type: z.literal("error"),
  requestId: z.string().optional(),
  code: z.enum([
    "invalid_message",
    "unauthenticated",
    "session_not_found",
    "internal",
    "unsupported",
    "rate_limited",
    "incompatible_protocol",
    // Filesystem browser errors (listDirectory / getFilesystemRoots).
    "not_found",
    "permission_denied",
    "not_a_directory",
  ]),
  message: z.string(),
});

// ─── Hello / server_info (wire-version handshake on DataChannel open) ─────
//
// iOS sends `hello` immediately after DC.open carrying its PROTOCOL_VERSION.
// Daemon checks compatibility via `isProtocolCompatible` and responds with
// its own `server_info` (or with `error{code:"incompatible_protocol"}` +
// DC close on mismatch). iOS treats `server_info` as the "ready" signal —
// application commands may only flow after it arrives.
//
// Single field exchanged each way. There's no separate "app release
// version" / "daemon release version" — the protocol package owns the
// only version that matters for whether the two ends can talk.

export const helloCommand = z.object({
  type: z.literal("hello"),
  protocolVersion: z.string(),
});

export const serverInfoEvent = z.object({
  type: z.literal("server_info"),
  protocolVersion: z.string(),
});

export type HelloCommand = z.infer<typeof helloCommand>;
export type ServerInfoEvent = z.infer<typeof serverInfoEvent>;

// ─── Top-level direction unions (parse the wire against these) ─────────────

export const command = z.discriminatedUnion("type", [
  subscribeCommand,
  unsubscribeCommand,
  sendPromptCommand,
  setSessionSelectionCommand,
  interruptCommand,
  approveCommand,
  stopTaskCommand,
  listSessionsCommand,
  deleteSessionCommand,
  continueOnDesktopCommand,
  getMessagesCommand,
  subscribeGitStatusCommand,
  unsubscribeGitStatusCommand,
  listDirectoryCommand,
  getFilesystemRootsCommand,
  getModelsCommand,
]);

export type Command = z.infer<typeof command>;

export const response = z.discriminatedUnion("type", [
  subscribeResponse,
  unsubscribeResponse,
  sendPromptResponse,
  setSessionSelectionResponse,
  interruptResponse,
  listSessionsResponse,
  deleteSessionResponse,
  continueOnDesktopResponse,
  getMessagesResponse,
  subscribeGitStatusResponse,
  unsubscribeGitStatusResponse,
  listDirectoryResponse,
  getFilesystemRootsResponse,
  getModelsResponse,
]);

export type Response = z.infer<typeof response>;

/** All frames a client may send to the daemon over the authenticated
 *  DataChannel. Identity binding lives at the DTLS layer via SDP-
 *  fingerprint signing — by the time anything arrives on the channel,
 *  the peer is already cryptographically bound to a known pubkey.
 *  `hello` is the only frame the daemon accepts before the wire-version
 *  handshake completes (see helloCommand). */
export const clientFrame = z.discriminatedUnion("type", [
  helloCommand,
  pingFrame,
  subscribeCommand,
  unsubscribeCommand,
  sendPromptCommand,
  setSessionSelectionCommand,
  interruptCommand,
  approveCommand,
  stopTaskCommand,
  listSessionsCommand,
  deleteSessionCommand,
  continueOnDesktopCommand,
  getMessagesCommand,
  subscribeGitStatusCommand,
  unsubscribeGitStatusCommand,
  listDirectoryCommand,
  getFilesystemRootsCommand,
  getModelsCommand,
]);

export type ClientFrame = z.infer<typeof clientFrame>;

/** All frames the daemon may send to a client over the authenticated
 *  DataChannel. `server_info` is daemon's reply to `hello` and the
 *  signal that the client may begin sending application commands. */
export const daemonFrame = z.discriminatedUnion("type", [
  serverInfoEvent,
  pongFrame,
  errorFrame,
  sessionUpdatedEvent,
  approvalRequestEvent,
  sessionDivergedEvent,
  sessionForkedEvent,
  subscribeResponse,
  unsubscribeResponse,
  sendPromptResponse,
  setSessionSelectionResponse,
  interruptResponse,
  eventFrame,
  listSessionsResponse,
  deleteSessionResponse,
  continueOnDesktopResponse,
  getMessagesResponse,
  subscribeGitStatusResponse,
  unsubscribeGitStatusResponse,
  gitStatusEvent,
  listDirectoryResponse,
  getFilesystemRootsResponse,
  getModelsResponse,
]);

export type DaemonFrame = z.infer<typeof daemonFrame>;
