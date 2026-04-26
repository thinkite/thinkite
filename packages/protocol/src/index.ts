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
  daemonAddress: z.string(), // ws://host:port — direct connect, no relay in V0
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

// ─── Session metadata (mirrors SDKSessionInfo, intentionally redeclared) ───

export const sessionInfo = z.object({
  sessionId: z.string(),
  summary: z.string(),
  lastModified: z.number(),
  fileSize: z.number().optional(),
  customTitle: z.string().optional(),
  firstPrompt: z.string().optional(),
  gitBranch: z.string().optional(),
  cwd: z.string().optional(),
  tag: z.string().nullable().optional(),
  createdAt: z.number().optional(),
});

export type SessionInfo = z.infer<typeof sessionInfo>;

// ─── Commands: client → daemon (fire-and-forget; effects via events) ───────

export const subscribeCommand = z.object({
  type: z.literal("subscribe"),
  sessionId: z.string(),
});

export const sendPromptCommand = z.object({
  type: z.literal("sendPrompt"),
  sessionId: z.string(),
  text: z.string(),
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
  sendPromptCommand,
  approveCommand,
  stopTaskCommand,
  listSessionsCommand,
  deleteSessionCommand,
  continueOnDesktopCommand,
]);

export type Command = z.infer<typeof command>;

export const response = z.discriminatedUnion("type", [
  listSessionsResponse,
  deleteSessionResponse,
  continueOnDesktopResponse,
]);

export type Response = z.infer<typeof response>;

/** All frames a client may send to the daemon over WS. */
export const clientFrame = z.discriminatedUnion("type", [
  clientHelloFrame,
  clientAuthFrame,
  pingFrame,
  subscribeCommand,
  sendPromptCommand,
  approveCommand,
  stopTaskCommand,
  listSessionsCommand,
  deleteSessionCommand,
  continueOnDesktopCommand,
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
  listSessionsResponse,
  deleteSessionResponse,
  continueOnDesktopResponse,
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
