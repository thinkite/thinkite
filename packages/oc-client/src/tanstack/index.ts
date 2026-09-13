/**
 * `@thinkite/oc-client/tanstack` — TanStack DB collections over the
 * framework-agnostic opencode 2 client: the session list plus lazily
 * created per-session transcript collections (rows are opencode's own
 * `SessionMessageInfo`), with paging state alongside.
 *
 * No React here: apps read these collections with `useLiveQuery`.
 * Runtime stays Hermes-safe — no `node:*`, no DOM-only globals.
 */

export {
  createSessionsCollection,
  type SessionActivity,
  type SessionRow,
  type SessionsCollectionOptions,
} from "./sessions.ts";
export {
  createTranscriptCollections,
  type SendMessageVars,
  type TranscriptCollections,
  type TranscriptCollectionsOptions,
  type TranscriptPagingRow,
} from "./transcript.ts";
