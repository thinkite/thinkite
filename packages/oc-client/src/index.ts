/**
 * `@thinkite/oc-client` — framework-agnostic opencode 2 access for
 * Thinkite frontends (desktop + iOS).
 *
 * No React, no DOM, no Node-only APIs in this entry.
 */

export type {
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationInfo,
} from "./client.ts";
export {
  type AgentInfo,
  type CommandInfo,
  createOcClient,
  type DiffMode,
  type FileDiffInfo,
  type FoundPath,
  type ModelInfo,
  type ModelRef,
  type OcClient,
  type OcClientOptions,
  type OcEventStreamOptions,
  type OcMessagePage,
  type OcSessionPage,
  type OpenCodeClient,
  type OpenCodeEvent,
  type PromptFile,
  type PromptMention,
  type PromptParts,
  type ProviderInfo,
  type ServerInfo,
  type SessionInboxUser,
  type SessionInfo,
  type SessionMessageInfo,
  type SessionRevert,
  type SkillInfo,
  type VcsFileStatus,
  type VcsInfo,
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
  type SessionStatus,
  statusFromEvent,
} from "./session-reducer.ts";
export {
  type ConnectionStatus,
  costWithin,
  createOcStore,
  descendantsOf,
  type FormAnswer,
  isUnread,
  lineageOf,
  type OcStore,
  type OcStoreOptions,
  type Paging,
  type Pending,
  rootOf,
} from "./store/store.ts";
export {
  type FileDiff,
  toolDiffs,
  toolOutput,
  toolSummary,
} from "./tool-format.ts";
export {
  applyTranscriptEvent,
  mergeProjection,
  messageIDFromEvent,
  STREAMING_EVENT_TYPES,
  type TranscriptRows,
  TURN_END_EVENT_TYPES,
  visibleMessages,
} from "./transcript-reducer.ts";
export {
  contextTokens,
  lastAssistantWithUsage,
  type TokenUsage,
} from "./usage.ts";
