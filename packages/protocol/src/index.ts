import { z } from "zod";

export const PROTOCOL_VERSION = "0.0.1";

// ─── Handshake protocol ────────────────────────────────────────────────────
//
// Inspired by Remodex's CodexSecureTransportModels.swift. See memory file
// `project_handshake_design.md` for full design rationale, transcript layout,
// and forward-compat plan for V1 frame encryption.
//
// Six-frame flow:
//   pair.offer        out-of-band (encoded in QR), daemon → client
//   client.hello      WS frame, client → daemon (first message after connect)
//   server.hello      WS frame, daemon → client (with daemonSignature)
//   client.auth       WS frame, client → daemon (with clientSignature)
//   server.ready      WS frame, daemon → client (handshake complete)
//   handshake.reject  WS frame, daemon → client (any failure)

/** Wire protocol version for handshake frames. Bump on incompat changes. */
export const HANDSHAKE_VERSION = 1;

/** Domain tag prepended to transcript bytes. Provides cross-protocol separation. */
export const HANDSHAKE_DOMAIN_TAG = "sidecode-handshake-v1";

/**
 * Suffix appended to transcript when client signs. Prevents an attacker from
 * replaying the daemon's signature as the client's.
 */
export const CLIENT_AUTH_LABEL = "client-auth";

export const handshakeMode = z.enum(["qr_bootstrap", "trusted_reconnect"]);
export type HandshakeMode = z.infer<typeof handshakeMode>;

/**
 * QR offer payload. Stateless metadata — daemon does NOT track which offers
 * it has issued. Anyone with a non-expired offer + daemon's address can
 * attempt qr_bootstrap; per-handshake nonces and signatures provide all
 * security guarantees, not offer consumption.
 *
 * Within `expiresAt` window the same offer is valid for multiple pair
 * attempts (e.g. user paired phone, paired iPad off the same QR). Daemon's
 * "client_already_paired" rejection prevents double-pair of the same
 * client fingerprint.
 */
export const pairOfferFrame = z.object({
  type: z.literal("pair.offer"),
  v: z.number().int(),
  daemonFingerprint: z.string(), // 16 hex chars, SHA256(pubkey).slice(0,16)
  daemonIdentityPublicKey: z.string(), // base64url ed25519 raw pubkey
  /**
   * Ordered candidate ws URLs the client should try, first-match-wins.
   * Daemon advertises multiple paths so the same offer works whether the
   * phone is on the same Wi-Fi (LAN address), on a Tailscale tailnet
   * (CGNAT address), or on a simulator that shares loopback. Client
   * tries them sequentially with a short per-attempt timeout — see
   * Paseo's HostConnection candidate set for the inspiration.
   *
   * `min(1)`: at least one address (typically loopback for simulator
   * pairing). Empty array would mean "no way to connect" which is never
   * useful.
   */
  daemonAddresses: z.array(z.string()).min(1),
  serviceName: z.string(),
  expiresAt: z.number(), // epoch ms; daemon enforces now <= this on hello
});

export const clientHelloFrame = z.object({
  type: z.literal("client.hello"),
  v: z.number().int(),
  /** Per-handshake correlation ID (client-generated UUID). Not a server-issued
   *  token; daemon uses it only to thread hello → server.hello → auth → ready
   *  through the same pendingTranscripts entry. */
  sessionId: z.string(),
  mode: handshakeMode,
  clientFingerprint: z.string(),
  clientIdentityPublicKey: z.string(),
  clientNonce: z.string(), // base64url 32 bytes
  /** qr_bootstrap mode only: echoed from the offer the client scanned.
   *  Daemon uses these to validate (a) the offer was for this daemon and
   *  (b) the offer hasn't expired. Omit (or ignore) for trusted_reconnect. */
  offerExpiresAt: z.number().optional(),
  offerDaemonFingerprint: z.string().optional(),
});

export const serverHelloFrame = z.object({
  type: z.literal("server.hello"),
  v: z.number().int(),
  sessionId: z.string(),
  mode: handshakeMode,
  daemonFingerprint: z.string(),
  daemonIdentityPublicKey: z.string(),
  serverNonce: z.string(), // base64url 32 bytes
  clientNonce: z.string(), // echo for client to verify
  keyEpoch: z.number().int(), // V0 always 1; V1+ rotation marker
  expiresAt: z.number(), // matches pair.offer.expiresAt for transcript
  daemonSignature: z.string(), // base64url ed25519 signature over transcript
});

export const clientAuthFrame = z.object({
  type: z.literal("client.auth"),
  v: z.number().int(),
  sessionId: z.string(),
  clientFingerprint: z.string(),
  keyEpoch: z.number().int(),
  clientSignature: z.string(), // base64url ed25519 signature over (transcript || CLIENT_AUTH_LABEL)
});

export const serverReadyFrame = z.object({
  type: z.literal("server.ready"),
  v: z.number().int(),
  sessionId: z.string(),
  daemonFingerprint: z.string(),
  keyEpoch: z.number().int(),
});

export const handshakeRejectCode = z.enum([
  "invalid_signature",
  "session_expired",
  "session_unknown", // sessionId not in pending offers (qr_bootstrap)
  "client_unknown", // clientFingerprint not in known_clients (trusted_reconnect)
  "client_already_paired", // qr_bootstrap but client is already in known_clients
  "version_mismatch",
  "mode_mismatch", // server's mode doesn't match what client requested
  "internal",
]);
export type HandshakeRejectCode = z.infer<typeof handshakeRejectCode>;

export const handshakeRejectFrame = z.object({
  type: z.literal("handshake.reject"),
  v: z.number().int(),
  sessionId: z.string().optional(),
  code: handshakeRejectCode,
  message: z.string(),
});

export type PairOfferFrame = z.infer<typeof pairOfferFrame>;
export type ClientHelloFrame = z.infer<typeof clientHelloFrame>;
export type ServerHelloFrame = z.infer<typeof serverHelloFrame>;
export type ClientAuthFrame = z.infer<typeof clientAuthFrame>;
export type ServerReadyFrame = z.infer<typeof serverReadyFrame>;
export type HandshakeRejectFrame = z.infer<typeof handshakeRejectFrame>;

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
  model: z.string().optional(),
  completedTurns: z.number().optional(),
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

// NOTE: TodoWrite removed in prep for Agent SDK 0.3.142+, which replaces
// TodoWrite with TaskCreate / TaskUpdate / TaskGet / TaskList (per-id
// increments, not snapshot writes). Re-add a `task` detail variant + daemon
// accumulator when we wire those tools back in.

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
    /** Combined text output the model saw (stdout+stderr+errors as one blob). */
    output: z.string(),
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
    text: z.string(),
  }),
  z.object({
    type: z.literal("assistant_message"),
    uuid: z.string(),
    text: z.string(),
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

/**
 * Send a user prompt into a session.
 *
 * `cwd` is REQUIRED on the first sendPrompt for a session that doesn't yet
 * have JSONL on disk (= iOS-creating a new session). Daemon checks via
 * SDK's `getSessionInfo(sessionId)`; missing-cwd-for-new-session → daemon
 * replies with `{ type: "error", code: "invalid_message" }`. For resume
 * (session already exists), `cwd` is ignored — SDK uses the persisted cwd.
 */
export const sendPromptCommand = z.object({
  type: z.literal("sendPrompt"),
  requestId: z.string(),
  sessionId: z.string(),
  text: z.string(),
  cwd: z.string().optional(),
});

export const sendPromptResponse = z.object({
  type: z.literal("sendPrompt.response"),
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
  ]),
  message: z.string(),
});

// ─── Top-level direction unions (parse the wire against these) ─────────────

export const command = z.discriminatedUnion("type", [
  subscribeCommand,
  unsubscribeCommand,
  sendPromptCommand,
  interruptCommand,
  approveCommand,
  stopTaskCommand,
  listSessionsCommand,
  deleteSessionCommand,
  continueOnDesktopCommand,
  getMessagesCommand,
]);

export type Command = z.infer<typeof command>;

export const response = z.discriminatedUnion("type", [
  subscribeResponse,
  unsubscribeResponse,
  sendPromptResponse,
  interruptResponse,
  listSessionsResponse,
  deleteSessionResponse,
  continueOnDesktopResponse,
  getMessagesResponse,
]);

export type Response = z.infer<typeof response>;

/** All frames a client may send to the daemon over WS. */
export const clientFrame = z.discriminatedUnion("type", [
  clientHelloFrame,
  clientAuthFrame,
  pingFrame,
  subscribeCommand,
  unsubscribeCommand,
  sendPromptCommand,
  interruptCommand,
  approveCommand,
  stopTaskCommand,
  listSessionsCommand,
  deleteSessionCommand,
  continueOnDesktopCommand,
  getMessagesCommand,
]);

export type ClientFrame = z.infer<typeof clientFrame>;

/** All frames the daemon may send to a client over WS. */
export const daemonFrame = z.discriminatedUnion("type", [
  serverHelloFrame,
  serverReadyFrame,
  handshakeRejectFrame,
  pongFrame,
  errorFrame,
  sessionUpdatedEvent,
  approvalRequestEvent,
  sessionDivergedEvent,
  sessionForkedEvent,
  subscribeResponse,
  unsubscribeResponse,
  sendPromptResponse,
  interruptResponse,
  eventFrame,
  listSessionsResponse,
  deleteSessionResponse,
  continueOnDesktopResponse,
  getMessagesResponse,
]);

export type DaemonFrame = z.infer<typeof daemonFrame>;

// ─── Transcript builder (used by both daemon and client to compute the bytes
//     that get signed during handshake) ────────────────────────────────────

export interface TranscriptInput {
  sessionId: string;
  protocolVersion: number;
  mode: HandshakeMode;
  keyEpoch: number;
  daemonFingerprint: string;
  clientFingerprint: string;
  daemonIdentityPublicKey: string; // base64url
  clientIdentityPublicKey: string; // base64url
  clientNonce: string; // base64url
  serverNonce: string; // base64url
  expiresAt: number;
}

/**
 * Build the transcript bytes for handshake signature. Length-prefixed concat
 * (u32 BE + payload) prevents field-boundary ambiguity. base64url-encoded
 * fields are decoded before being included so the same bytes are reachable
 * from any platform without depending on the chosen text encoding.
 *
 * Daemon signs `buildTranscript(...)` directly.
 * Client signs `buildTranscript(...) || CLIENT_AUTH_LABEL` (UTF-8 bytes).
 */
export function buildTranscript(input: TranscriptInput): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(prefix(textBytes(HANDSHAKE_DOMAIN_TAG)));
  parts.push(prefix(textBytes(input.sessionId)));
  parts.push(prefix(textBytes(String(input.protocolVersion))));
  parts.push(prefix(textBytes(input.mode)));
  parts.push(prefix(textBytes(String(input.keyEpoch))));
  parts.push(prefix(textBytes(input.daemonFingerprint)));
  parts.push(prefix(textBytes(input.clientFingerprint)));
  parts.push(prefix(b64urlBytes(input.daemonIdentityPublicKey)));
  parts.push(prefix(b64urlBytes(input.clientIdentityPublicKey)));
  parts.push(prefix(b64urlBytes(input.clientNonce)));
  parts.push(prefix(b64urlBytes(input.serverNonce)));
  parts.push(prefix(textBytes(String(input.expiresAt))));
  return concat(parts);
}

/** Bytes to sign on the client side. Daemon never signs this variant. */
export function buildClientAuthTranscript(input: TranscriptInput): Uint8Array {
  const base = buildTranscript(input);
  const label = textBytes(CLIENT_AUTH_LABEL);
  return concat([base, label]);
}

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function b64urlBytes(b64url: string): Uint8Array {
  // base64url → standard base64, with padding restored.
  const padded = b64url + "===".slice(0, (4 - (b64url.length % 4)) % 4);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  // `atob` is global in Node 18+ and all evergreen browsers.
  const bin = atob(std);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function prefix(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  // big-endian u32 length
  out[0] = (bytes.length >>> 24) & 0xff;
  out[1] = (bytes.length >>> 16) & 0xff;
  out[2] = (bytes.length >>> 8) & 0xff;
  out[3] = bytes.length & 0xff;
  out.set(bytes, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
