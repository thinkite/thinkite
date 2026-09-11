/**
 * `@thinkite/oc-client/tanstack` — TanStack DB glue over the
 * framework-agnostic opencode client (desktop now, iOS in stage 3): the
 * sessions collection plus lazily created per-session transcript
 * collections, fed by the pure reducers.
 *
 * No React here: apps read these collections with `useLiveQuery` (or the
 * framework binding of their choice). Runtime stays Hermes-safe — no
 * `node:*`, no DOM-only globals, no `Buffer` (TanStack DB itself is fine
 * on Hermes).
 */

export {
  createSessionsCollection,
  type SessionRow,
  type SessionsCollectionOptions,
} from "./sessions.ts";
export {
  createTranscriptCollections,
  type OrderedOcRow,
  type SendMessageVars,
  type TranscriptCollections,
  type TranscriptCollectionsOptions,
} from "./transcript.ts";
