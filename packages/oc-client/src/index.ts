/**
 * `@thinkite/oc-client` — framework-agnostic opencode 2 access for
 * Thinkite frontends (desktop + iOS).
 *
 * No React, no DOM, no Node-only APIs in this entry.
 */

export {
  type AgentInfo,
  createOcClient,
  type ModelInfo,
  type ModelRef,
  type OcClient,
  type OcClientOptions,
  type OcEventStreamOptions,
  type OcMessagePage,
  type OcSessionPage,
  type OpenCodeClient,
  type OpenCodeEvent,
  type ProviderInfo,
  type ServiceHealth,
  type SessionInboxUser,
  type SessionInfo,
  type SessionMessageInfo,
} from "./client.ts";
export {
  durableSeq,
  type OcEvent,
  type OcEventOf,
  type OcEventType,
  type SubscribeEventsOptions,
  sessionIDOf,
  subscribeEvents,
} from "./events.ts";
export { mintMessageId } from "./identifier.ts";
export { formatModelRef, parseModelRef } from "./model-ref.ts";
export {
  applySessionEvent,
  type SessionActivity,
  type SessionRow,
  sessionRowFromCreated,
  sessionRowFromInfo,
} from "./session-reducer.ts";
export {
  applyTranscriptEvent,
  mergeProjection,
  messageIDFromEvent,
  STREAMING_EVENT_TYPES,
  type TranscriptRows,
  TURN_END_EVENT_TYPES,
} from "./transcript-reducer.ts";
