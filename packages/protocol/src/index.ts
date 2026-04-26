import { z } from "zod";

export const PROTOCOL_VERSION = "0.0.1";

// ─── Pairing handshake (before any other traffic) ──────────────────────────

/**
 * Schema version of pair.offer payload. Bumped when the pair.offer fields
 * change in a way that requires client awareness.
 *
 * Clients should parse `v` first, and if it doesn't match the version they
 * understand, surface a "please update sidecode" prompt instead of failing
 * the rest of the schema parse with a generic error. This is the same
 * pattern Remodex uses (`looksLikeRemodexPayload` + bridgeUpdateRequired).
 */
export const PAIR_OFFER_VERSION = "0.0.1";

export const pairOfferFrame = z.object({
  type: z.literal("pair.offer"),
  v: z.string(),
  daemonPubkey: z.string(),
  fingerprint: z.string(),
  challenge: z.string(),
  challengeExpiresAt: z.number(),
  serviceName: z.string(),
});

export const pairProofFrame = z.object({
  type: z.literal("pair.proof"),
  clientPubkey: z.string(),
  signature: z.string(),
});

export const pairAcceptFrame = z.object({
  type: z.literal("pair.accept"),
  clientFingerprint: z.string(),
});

export const pairRejectFrame = z.object({
  type: z.literal("pair.reject"),
  reason: z.string(),
});

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
// We don't import from @anthropic-ai/claude-agent-sdk to keep this package
// SDK-agnostic; clients (iOS) shouldn't need to install the SDK to consume
// the protocol.

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

// ─── Top-level direction unions (use these when parsing the wire) ──────────

export const command = z.discriminatedUnion("type", [
  subscribeCommand,
  sendPromptCommand,
  approveCommand,
  stopTaskCommand,
  listSessionsCommand,
  deleteSessionCommand,
]);

export type Command = z.infer<typeof command>;

export const response = z.discriminatedUnion("type", [
  listSessionsResponse,
  deleteSessionResponse,
]);

export type Response = z.infer<typeof response>;

// All frames a paired client may send to the daemon over WS.
export const clientFrame = z.discriminatedUnion("type", [
  pairProofFrame,
  pingFrame,
  subscribeCommand,
  sendPromptCommand,
  approveCommand,
  stopTaskCommand,
  listSessionsCommand,
  deleteSessionCommand,
]);

export type ClientFrame = z.infer<typeof clientFrame>;

// All frames the daemon may send to a paired client over WS.
export const daemonFrame = z.discriminatedUnion("type", [
  pairOfferFrame,
  pairAcceptFrame,
  pairRejectFrame,
  pongFrame,
  errorFrame,
  sessionUpdatedEvent,
  approvalRequestEvent,
  sessionDivergedEvent,
  sessionForkedEvent,
  listSessionsResponse,
  deleteSessionResponse,
]);

export type DaemonFrame = z.infer<typeof daemonFrame>;
