import type { TimelineItem } from "@sidecodeapp/protocol";
import type { Collection } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import type { QueryClient } from "@tanstack/react-query";

/**
 * Augmented item type stored inside the collection. `_order` is an
 * iOS-internal monotonic counter used purely for sorting; NOT part of
 * the wire protocol.
 *
 * Why we need it: TanStack DB stores items in a `SortedMap` internally.
 * Without a `compare` function, it falls back to sorting by KEY — our
 * key is `uuid` (a random string), so chronological order gets shredded
 * into lexical-by-random order. Even though SDK's getSessionMessages
 * returns items in the correct chronological order, the collection
 * scrambles them on insert.
 *
 * Why not `timestamp`: SessionMessage HAS a `timestamp` field but it's
 * not monotonic — verified empirically. Around compact boundaries the
 * SDK-injected summary message uses fresh time while the following
 * `<command-name>/compact</command-name>` echo uses the original
 * (older) command time. Plus same-envelope items (text + tool_use
 * blocks) share a timestamp, requiring a tiebreaker anyway. Using
 * array-index `_order` sidesteps both issues — the SDK array order IS
 * the canonical chronological order (it has already done parent_uuid
 * chain reconstruction), we just preserve it.
 *
 * Structural-typing note: `OrderedTimelineItem` extends `TimelineItem`
 * with one extra field; consumers expecting `TimelineItem[]` (like
 * `flattenToBlocks`) accept it without changes.
 */
export type OrderedTimelineItem = TimelineItem & { _order: number };

/**
 * Module-level per-session collection cache for transcript items.
 * Implements the maintainer-blessed pattern from TanStack/db#652:
 *   - One collection per cliSessionId, keyed in a Map
 *   - Cache eviction wired to the collection's own `status:change` event
 *     so when TanStack DB's gcTime timer fires `cleanup()`, the entry
 *     drops out of the cache automatically — no manual ref counting
 *
 * Why Map (not WeakMap):
 *   - WeakMap requires object keys; our sessionId is a string primitive
 *   - Eviction via `status:change` is deterministic; WeakMap's GC timing
 *     is not, and we can't `console.log(cache.size)` to debug
 *
 * Why module-level (not inside the hook):
 *   - useMemo inside a component would re-create the collection on
 *     every cliSessionId change AND fail to share the instance across
 *     two components viewing the same session
 *   - Module-level means `getTranscriptCollection("alpha")` from any
 *     caller returns the same Collection instance
 *
 * gcTime (60s) tradeoff:
 *   - User navigates away from a session → 60s window where re-mount
 *     hits the cache (instant render)
 *   - After 60s no subscribers → TanStack DB auto-cleanup → entry
 *     drops from this Map via the status:change listener
 *   - Tuned for iOS where memory pressure matters and users typically
 *     view one session at a time. Default would be 5min (300_000ms);
 *     we go shorter to be a good mobile citizen
 *
 * Future migration (V0.5+): when TanStack/db#315 ships
 * `createPartitionedCollection`, this factory becomes a thin shim or
 * is removed entirely — the partitioned API will handle per-key
 * collection lifecycle natively.
 */

const cache = new Map<string, Collection<OrderedTimelineItem, string>>();

const GC_TIME_MS = 60_000;

export interface TranscriptCollectionDeps {
  queryClient: QueryClient;
}

export function getTranscriptCollection(
  cliSessionId: string,
  deps: TranscriptCollectionDeps,
): Collection<OrderedTimelineItem, string> {
  const cached = cache.get(cliSessionId);
  if (cached !== undefined) return cached;

  const collection = createCollection(
    queryCollectionOptions({
      // Stable id for debugging + matches TanStack Query devtools naming
      id: `transcript-${cliSessionId}`,
      queryClient: deps.queryClient,
      queryKey: ["messages", cliSessionId],
      // Empty queryFn — the subscribe stream is the sole source of
      // truth for transcript data. queryFn resolving immediately is
      // what flips the collection out of `pending` state so
      // writeInsert/writeDelete work; the actual rows come from the
      // facade Subscription's `onSubscribed` (cold-path settled
      // ingest) + `onEvent` (live deltas). This eliminates the
      // duplicate fetch path that previously had queryFn AND
      // subscribe both pulling the same JSONL.
      queryFn: async (): Promise<OrderedTimelineItem[]> => [],
      // staleTime: Infinity — without this, React Query's default
      // (`staleTime: 0`) treats data as stale immediately, so every
      // time a new useLiveQuery observer mounts (e.g. user navs back
      // to a cached session within gcTime), React Query re-fires
      // queryFn → TanStack DB syncs collection to [] → any items
      // previously written via subscribe.onSubscribed / onEvent get
      // wiped. The downstream subscribe handler tries to reinsert,
      // but the writeBatch can collide with the in-flight queryFn
      // reconciliation and leave `isInitialLoading` stuck true.
      //
      // Since subscribe is the only source of truth here, queryFn
      // should run exactly once per collection lifetime — to flip
      // status pending → ready on creation, and never again. Setting
      // staleTime: Infinity tells React Query "data is never stale,
      // never refetch."
      staleTime: Number.POSITIVE_INFINITY,
      // tool_call rows use `callId` (Anthropic tool_use_id) as their
      // identity. user_message / assistant_message use `uuid`. The
      // collection key has to discriminate both — patch_tool_call
      // deltas reference `callId`, so picking `callId` for tool rows
      // lets writeUpdate({callId, ...}) match cleanly without a
      // synthetic compound key.
      getKey: (item: OrderedTimelineItem): string =>
        item.type === "tool_call" ? item.callId : item.uuid,
      // Sort by our injected `_order` field, NOT by key. See the
      // OrderedTimelineItem JSDoc for the longer rationale.
      compare: (a, b) => a._order - b._order,
      gcTime: GC_TIME_MS,
    }),
  );

  // Auto-evict from this Map when the collection finishes its own
  // cleanup lifecycle. Without this listener, an evicted collection
  // would leave a stale dead entry in the cache; subsequent
  // get-for-same-sessionId would return a cleaned-up collection that
  // throws on write ops. PR TanStack/db#714 (in our 0.6.7) guarantees
  // the status:change event fires BEFORE event handlers are cleared,
  // so this delete is reliable.
  collection.on("status:change", ({ status }) => {
    if (status === "cleaned-up") {
      cache.delete(cliSessionId);
    }
  });

  cache.set(cliSessionId, collection);
  return collection;
}
