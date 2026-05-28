import type { TimelineItem, TurnUsage } from "@sidecodeapp/protocol";
import type { Collection } from "@tanstack/db";
import { createCollection } from "@tanstack/react-db";
import { useSyncExternalStore } from "react";
import type { DaemonClient } from "@/lib/daemon-client";

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
 * Per-session ephemeral state that lives next to the transcript
 * collection but doesn't fit as a row inside it. The collection holds
 * TimelineItems (chat content); these three fields are turn-machine
 * status that the UI displays but isn't "an item."
 *
 * Driven by the same sync handler that drives the collection — both
 * update from one Subscription callback. Exposed to React via
 * `useSessionMeta(cliSessionId)` (useSyncExternalStore wrapper below).
 *
 * Lives only while the collection lives (factory map). Cleared on the
 * collection's sync-handler cleanup (gcTime expiry).
 */
export interface SessionMeta {
  isRunning: boolean;
  lastError: string | null;
  latestUsage: TurnUsage | null;
}

const EMPTY_META: SessionMeta = {
  isRunning: false,
  lastError: null,
  latestUsage: null,
};

/**
 * Module-level per-session collection cache. Implements the
 * maintainer-blessed pattern from TanStack/db#652:
 *   - One collection per cliSessionId, keyed in a Map
 *   - Cache eviction wired to `status:change` event so when TanStack
 *     DB's gcTime timer fires `cleanup()`, the entry drops out of
 *     this Map automatically — no manual ref counting
 *
 * The collection's `sync` config opens a single `client.subscribe(...)`
 * call inside its handler. This is THE difference vs the old
 * queryCollectionOptions approach:
 *   - Old: queryFn was vestigial (returned [], needed staleTime:Infinity
 *     to stop React Query from re-firing it); subscribe lived in the
 *     consumer hook's useEffect → one subscription per hook mount
 *   - New: sync handler owns the subscription → one subscription per
 *     collection lifetime → multiple consumers viewing the same session
 *     share one subscription → back-nav within gcTime doesn't even
 *     close+reopen the subscribe RPC (sync handler keeps running)
 *
 * Future migration (V0.5+): when TanStack/db#315 ships
 * `createPartitionedCollection`, this factory becomes a thin shim or
 * is removed entirely.
 */
const collections = new Map<string, Collection<OrderedTimelineItem, string>>();
const metas = new Map<string, SessionMeta>();
const metaListeners = new Map<string, Set<() => void>>();
const GC_TIME_MS = 60_000;

function emitMetaChange(cliSessionId: string): void {
  const listeners = metaListeners.get(cliSessionId);
  if (listeners === undefined) return;
  for (const cb of listeners) cb();
}

function updateMeta(
  cliSessionId: string,
  patch: Partial<SessionMeta>,
): void {
  const current = metas.get(cliSessionId) ?? EMPTY_META;
  metas.set(cliSessionId, { ...current, ...patch });
  emitMetaChange(cliSessionId);
}

export interface TranscriptCollectionDeps {
  client: DaemonClient;
}

export function getTranscriptCollection(
  cliSessionId: string,
  deps: TranscriptCollectionDeps,
): Collection<OrderedTimelineItem, string> {
  const cached = collections.get(cliSessionId);
  if (cached !== undefined) return cached;

  // Seed meta so consumers reading via useSessionMeta before the
  // first turn fires get a stable EMPTY_META reference (not undefined).
  metas.set(cliSessionId, EMPTY_META);

  const collection = createCollection<OrderedTimelineItem, string>({
    id: `transcript-${cliSessionId}`,
    // tool_call rows use `callId` (Anthropic tool_use_id) as their
    // identity. user_message / assistant_message use `uuid`. The
    // collection key has to discriminate both.
    getKey: (item: OrderedTimelineItem): string =>
      item.type === "tool_call" ? item.callId : item.uuid,
    // Sort by our injected `_order` field, NOT by key.
    compare: (a, b) => a._order - b._order,
    gcTime: GC_TIME_MS,
    sync: {
      sync: ({ begin, write, commit, markReady, truncate, collection: coll }) => {
        // markReady() must be called exactly once per sync handler
        // lifetime to unblock useLiveQuery's isLoading. Subsequent
        // onSubscribed firings (e.g. on transport reconnect) re-ingest
        // settled but don't re-call markReady — collection is already
        // ready, we're just refreshing its contents.
        let hasMarkedReady = false;

        const sub = deps.client.subscribe(cliSessionId, {
          onEvent: (delta) => {
            switch (delta.kind) {
              case "append": {
                // `_order` continues from the collection's current size
                // — first event after a cold-path settled[] ingest gets
                // _order = settled.length; subsequent _order increments
                // by 1 per append.
                begin();
                write({
                  type: "insert",
                  value: { ...delta.item, _order: coll.size },
                });
                commit();
                break;
              }
              case "patch_text": {
                const current = coll.get(delta.uuid);
                if (current?.type !== "assistant_message") return;
                begin();
                write({
                  type: "update",
                  value: { ...current, text: current.text + delta.deltaText },
                });
                commit();
                break;
              }
              case "patch_tool_call": {
                const current = coll.get(delta.callId);
                if (current?.type !== "tool_call") return;
                begin();
                write({
                  type: "update",
                  value: {
                    ...current,
                    status: delta.status,
                    error: delta.error,
                    detail: delta.detail,
                  },
                });
                commit();
                break;
              }
              case "turn_started":
                updateMeta(cliSessionId, { isRunning: true, lastError: null });
                break;
              case "turn_completed":
                updateMeta(cliSessionId, {
                  isRunning: false,
                  ...(delta.usage !== undefined
                    ? { latestUsage: delta.usage }
                    : {}),
                });
                break;
              case "turn_failed":
                updateMeta(cliSessionId, {
                  isRunning: false,
                  lastError: delta.error,
                });
                break;
              case "turn_canceled":
                updateMeta(cliSessionId, { isRunning: false });
                break;
              case "compact_started":
              case "compact_applied":
                // V0.5+ — divider rendering + summary handling.
                break;
            }
          },
          onSubscribed: ({ recovered, settled, initialUsage }) => {
            if (!recovered) {
              // Cold path — daemon returned a full snapshot. truncate()
              // is an operation INSIDE a sync transaction (must be
              // bracketed by begin()/commit()), not a standalone clear.
              // TanStack DB internally buffers the truncate + the
              // subsequent inserts in the same transaction so observers
              // never see a flash of empty content. Works correctly
              // whether collection was empty (first subscribe) or had
              // stale items (reconnect with epoch mismatch).
              begin();
              truncate();
              for (let i = 0; i < settled.length; i += 1) {
                write({
                  type: "insert",
                  value: { ...settled[i], _order: i },
                });
              }
              commit();
            }
            if (initialUsage !== undefined) {
              updateMeta(cliSessionId, { latestUsage: initialUsage });
            }
            if (!hasMarkedReady) {
              markReady();
              hasMarkedReady = true;
            }
          },
        });

        // Cleanup runs when the collection's gcTime expires (no active
        // subscribers for ≥60s). Unsub from the facade — daemon stops
        // fanning events for this session to us. Clear our meta state
        // so a future re-create starts fresh.
        return () => {
          void sub.unsubscribe();
          metas.delete(cliSessionId);
          metaListeners.delete(cliSessionId);
        };
      },
    },
  });

  // Auto-evict from this Map when the collection finishes its own
  // cleanup lifecycle. Without this listener, an evicted collection
  // would leave a stale dead entry in the cache; subsequent
  // get-for-same-sessionId would return a cleaned-up collection that
  // throws on write ops. PR TanStack/db#714 (in our 0.6.7) guarantees
  // the status:change event fires BEFORE event handlers are cleared,
  // so this delete is reliable.
  collection.on("status:change", ({ status }) => {
    if (status === "cleaned-up") {
      collections.delete(cliSessionId);
    }
  });

  collections.set(cliSessionId, collection);
  return collection;
}

/**
 * React hook for the per-session turn-machine state (isRunning /
 * lastError / latestUsage). Uses `useSyncExternalStore` because the
 * state lives in a module-level Map driven by the collection's sync
 * handler — not React state — and useSyncExternalStore is the
 * canonical pattern for binding external mutable stores to React.
 *
 * Stable EMPTY_META is returned when the session has no entry (= the
 * collection is gc'd or never existed). useSyncExternalStore requires
 * the snapshot function to return a stable reference for unchanged
 * data; sharing one EMPTY_META singleton across all "no entry" reads
 * satisfies that.
 */
export function useSessionMeta(cliSessionId: string): SessionMeta {
  return useSyncExternalStore(
    (callback) => {
      let listeners = metaListeners.get(cliSessionId);
      if (listeners === undefined) {
        listeners = new Set();
        metaListeners.set(cliSessionId, listeners);
      }
      listeners.add(callback);
      return () => {
        listeners?.delete(callback);
      };
    },
    () => metas.get(cliSessionId) ?? EMPTY_META,
    () => EMPTY_META,
  );
}
