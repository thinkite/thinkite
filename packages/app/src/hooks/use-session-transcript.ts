import type { TurnUsage } from "@sidecodeapp/protocol";
import { useLiveQuery } from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useDaemonClient } from "@/lib/daemon-client-context";
import {
  getTranscriptCollection,
  type OrderedTimelineItem,
} from "@/lib/transcript-collection-factory";

/**
 * Reactive per-session transcript binding. Replaces the previous
 * `useLiveSession + timeline-reducer + useMessages` stack with a
 * TanStack DB QueryCollection driven by the daemon's getMessages
 * (initial fetch) + subscribe stream (live deltas).
 *
 * Architecture decisions:
 *
 * 1. **Per-session collection via module-level factory**
 *    (`getTranscriptCollection`). Maintainer-blessed pattern from
 *    TanStack/db#652 — one collection per cliSessionId, Map cache
 *    keyed by sessionId, auto-evict on `status:change` cleaned-up.
 *    Future migration to `createPartitionedCollection`
 *    (TanStack/db#315) when that lands.
 *
 * 2. **No useEffect cleanup() call**. TanStack DB's `gcTime` config
 *    (60s in our factory) handles the "no subscribers → wait → clean
 *    up" lifecycle. Component unmount drops the useLiveQuery
 *    subscription; if no other subscriber attaches within gcTime, the
 *    collection self-cleans and evicts from the factory cache.
 *    Manually calling `collection.cleanup()` on every unmount would
 *    nuke the 60s "back-nav cache" benefit.
 *
 * 3. **Turn lifecycle (isRunning / lastError / latestUsage) lives
 *    OUTSIDE the collection** as plain useState. These are
 *    per-session state, not items — folding them into the collection
 *    would force a tagged "control row" or a second collection just
 *    for state. Cheap useState in the hook is the right level.
 *
 * 4. **`useLiveQuery` deps include `[collection]`** — without this,
 *    the closure captures the collection reference once and never
 *    re-binds when the user switches sessions, leaving the new
 *    collection without subscribers (its queryFn never fires) and
 *    later manual writes throw `SyncNotInitializedError`. See the
 *    spike file for the longer story.
 *
 * 5. **Subscribe writes use `collection.utils.writeXxx`**, not
 *    `collection.update()`. The latter is the optimistic-mutation
 *    entry point and requires an `onUpdate` handler — for SDK-pushed
 *    events that are already canonical, direct writes bypass the
 *    optimistic system. Optimistic insert for user-typed prompts
 *    lands in Phase 3.
 *
 * 6. **Manual writes gated on `!isInitialLoading`**. The collection is
 *    in 'pending' state until queryFn first resolves; calling
 *    writeInsert/writeUpdate before then throws
 *    `SyncNotInitializedError`. Subscribe registration is deferred
 *    until the loading gate flips false.
 *
 * Return shape mirrors the old `useLiveSession` for drop-in
 * compatibility at the call site:
 *   - `items` / `isInitialLoading` (was `isLoading`)
 *   - `isRunning` / `lastError` / `latestUsage`
 *   - `error` (top-level subscribe failure)
 */
export function useSessionTranscript(cliSessionId: string) {
  const { client } = useDaemonClient();
  const queryClient = useQueryClient();

  const collection = useMemo(
    () =>
      client === null
        ? null
        : getTranscriptCollection(cliSessionId, { client, queryClient }),
    [cliSessionId, client, queryClient],
  );

  // useLiveQuery's queryFn can return `null` to enter a "disabled"
  // status — TanStack DB then yields `data: undefined` instead of
  // throwing. Critical for two transient states:
  //   - first mount before daemon-client is ready (client === null)
  //   - app backgrounds → WebRTC drops → daemon-client briefly
  //     re-initializes → useMemo recomputes collection as null, then
  //     non-null again as client reconnects
  // Without the null-guard the second case crashes with
  // `QueryBuilderError: Invalid source for live query`.
  //
  // Explicit `.orderBy(_order)` is the visible sort. The collection's
  // internal SortedMap also has a `compare` config doing the same
  // thing, but useLiveQuery's projection layer doesn't always inherit
  // that (depends on the query plan), so we apply orderBy here too as
  // belt-and-suspenders. `_order` is assigned by queryFn (idx in the
  // SDK-returned array) and by the live `append` handler below
  // (`collection.size`); see those sites + the OrderedTimelineItem
  // JSDoc in transcript-collection-factory.ts for the rationale.
  const { data, isLoading: liveQueryLoading } = useLiveQuery(
    (q) =>
      collection === null
        ? null
        : q.from({ item: collection }).orderBy(({ item }) => item._order, "asc"),
    [collection],
  );
  const items = data ?? [];

  // Match the old `isInitialLoading` semantic: true until the
  // collection has hydrated AND we've registered for live deltas.
  // useLiveQuery's isLoading covers the hydration half; we OR with
  // a local flag for the subscribe handshake.
  const isInitialLoading = client === null || collection === null || liveQueryLoading;

  // Turn lifecycle state — driven by subscribe callback below.
  const [isRunning, setIsRunning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [latestUsage, setLatestUsage] = useState<TurnUsage | null>(null);
  const [error, setError] = useState<Error | null>(null);

  // Subscribe to daemon live events + write deltas into the
  // collection. Cleanup pattern mirrors the old useLiveSession:
  // - `active` flag guards against state updates after unmount (the
  //   subscribe Promise can resolve, or a delta can arrive, after
  //   useEffect cleanup ran)
  // - if subscribe resolves AFTER unmount, still call its
  //   unsubscribe thunk so daemon doesn't keep fanning to a stale cb
  useEffect(() => {
    if (client === null || collection === null || isInitialLoading) return;

    let active = true;
    let cleanup: (() => Promise<void>) | null = null;
    setError(null);

    void client
      .subscribe(cliSessionId, (delta) => {
        if (!active) return;
        // writeBatch coalesces multiple writes into one collection
        // change event — even for single deltas it's harmless and
        // matches the WebSocket example pattern from TanStack docs.
        collection.utils.writeBatch(() => {
          switch (delta.kind) {
            case "append": {
              // `_order` continues from the initial snapshot's last
              // index. `collection.size` at the moment of insert =
              // next index since we never delete in Phase 2 (compact
              // prune lands in a follow-up slice). For full-compact
              // (the 99% case — verified empirically across all our
              // session JSONLs) this remains safe even after prune:
              // delete-then-insert means size first drops to 0, then
              // grows from 0. Partial compact (preservedSegment) IS
              // a theoretical collision case (surviving items keep
              // high _order values while size restarts low and
              // climbs into them), but sidecode-via-SDK paths can't
              // currently trigger partial — revisit when compact
              // prune actually lands.
              const ordered: OrderedTimelineItem = {
                ...delta.item,
                _order: collection.size,
              };
              collection.utils.writeInsert(ordered);
              break;
            }
            case "patch_text": {
              const cur = collection.get(delta.uuid);
              if (cur?.type !== "assistant_message") return;
              // Partial update — `_order` not touched, preserved.
              collection.utils.writeUpdate({
                uuid: delta.uuid,
                text: cur.text + delta.deltaText,
              } as Partial<OrderedTimelineItem>);
              break;
            }
            case "patch_tool_call":
              collection.utils.writeUpdate({
                type: "tool_call",
                callId: delta.callId,
                status: delta.status,
                error: delta.error,
                detail: delta.detail,
              } as Partial<OrderedTimelineItem>);
              break;
            case "turn_started":
              setIsRunning(true);
              setLastError(null);
              break;
            case "turn_completed":
              setIsRunning(false);
              if (delta.usage !== undefined) setLatestUsage(delta.usage);
              break;
            case "turn_failed":
              setIsRunning(false);
              setLastError(delta.error);
              break;
            case "turn_canceled":
              setIsRunning(false);
              break;
            case "compact_started":
            case "compact_applied":
              // Slice 2 follow-up commit will handle these — for now
              // they're no-ops at the items level (compact_applied
              // would prune + append divider when ready).
              break;
          }
        });
      })
      .then(({ initialUsage, unsubscribe }) => {
        if (!active) {
          void unsubscribe();
          return;
        }
        // initialUsage seeds the context meter on resume — daemon
        // extracts it from the JSONL's last assistant message. Without
        // this, the meter stays empty on resume until the next live
        // turn_completed.
        if (initialUsage !== undefined) setLatestUsage(initialUsage);
        cleanup = unsubscribe;
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err : new Error(String(err)));
      });

    return () => {
      active = false;
      void cleanup?.();
    };
  }, [client, cliSessionId, collection, isInitialLoading]);

  // Mirror old useLiveSession return shape so call sites don't need
  // to rename properties. Old field `isInitialLoading` maps directly;
  // `items` is now collection-backed but typed identically.
  return {
    items,
    isRunning,
    lastError,
    latestUsage,
    isInitialLoading,
    error,
  };
}
