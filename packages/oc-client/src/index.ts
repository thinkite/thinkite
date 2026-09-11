/**
 * `@thinkite/oc-client` — framework-agnostic opencode v2 access for
 * Thinkite frontends (desktop now, iOS in stage 3).
 *
 * No React, no DOM, no Node-only APIs in this entry (see `client.ts`).
 */

export type {
  AgentV2Info,
  ModelRef,
  ModelV2Info,
  ProviderV2Info,
  QuestionV2Reply,
  SessionDurableEvent,
  SessionInputAdmitted,
  SessionV2Info,
  V2Event,
} from "./client.ts";
export {
  createOcClient,
  OcApiError,
  type OcClient,
  type OcClientOptions,
  type OcHistoryPage,
  type OcSessionPage,
  type OcStreamOptions,
} from "./client.ts";
export { mintMessageId } from "./identifier.ts";
export {
  applyOcEvent,
  buildOcToolDetail,
  createInitialTranscriptState,
  foldOcEvents,
  type OcEventLike,
  type OcPermissionRequest,
  type OcQuestionRequest,
  type OcRow,
  type OcToolDetail,
  type OcToolStatus,
  type OcTranscriptState,
  type OcUsage,
  ocStatusTransition,
  ocToolOutputText,
  summaryForOcTool,
} from "./reducer.ts";
export {
  applySessionListEvent,
  applySessionListPage,
  createInitialSessionListState,
  normalizeSessionInfo,
  type OcSessionItem,
  type OcSessionListState,
} from "./session-list.ts";
