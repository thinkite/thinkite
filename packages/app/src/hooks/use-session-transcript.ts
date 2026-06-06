import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { useDaemonClient } from "@/lib/daemon-client-context";
import { useSessionTurnResult } from "@/lib/session-turn-result";
import { getTranscriptCollection } from "@/lib/transcript-collection-factory";

/**
 * Reactive per-session transcript binding. Pure reader on top of the
 * factory — all the heavy lifting (subscribe to daemon, ingest settled,
 * apply deltas, track turn state) lives inside the collection's `sync`
 * config in `transcript-collection-factory.ts`.
 *
 * Why this is so thin:
 *
 * 1. The collection's `sync` handler owns the subscription. One
 *    subscription per collection lifetime — survives back-nav within
 *    gcTime without close-and-reopen, gets cleaned up automatically
 *    when gcTime expires. Multiple consumers viewing the same session
 *    naturally share one subscription.
 *
 * 2. Latest-turn result (lastError / latestUsage) lives in a separate
 *    `localOnly` collection (`@/lib/session-turn-result`), written by the
 *    transcript sync handler and read here via `useSessionTurnResult` —
 *    kept OFF the transcript collection (it's not "an item"). Only
 *    `lastError` is surfaced here (for the detail screen's dev logging);
 *    `latestUsage` is read directly by InputBar for the context meter, and
 *    running-state comes from `sessionState.activity` (#17), not here.
 *
 * 3. `useLiveQuery.isLoading` is now the authoritative loading signal
 *    — flips false when the sync handler calls `markReady()` after
 *    first onSubscribed. No hand-rolled `isInitialLoading` useState.
 *
 * Return shape:
 *   - `collection` (the raw per-session transcript collection — threaded
 *     to ChatPanel so it can run a `useLiveQueryEffect` over the same
 *     instance for onEnter haptics, instead of re-deriving it via the
 *     factory)
 *   - `items` / `isInitialLoading`
 *   - `lastError` (last turn failure — drives the detail screen's
 *     console.error; not rendered)
 *   - `error` (terminal subscribe failure — none today since the
 *     facade retries forever; field kept for API compat, always null)
 */
export function useSessionTranscript(cliSessionId: string, isNew = false) {
  const { client } = useDaemonClient();

  // `isNew` is only read at first collection creation (the daemon honors
  // it on first attach only). A cache hit returns the existing collection
  // and ignores it, so keeping it out of the memo deps is correct — but it
  // IS listed so the (stable-per-mount) value is captured cleanly without
  // tripping exhaustive-deps; a re-run just returns the cached collection.
  const collection = useMemo(
    () => getTranscriptCollection(cliSessionId, { client, isNew }),
    [cliSessionId, client, isNew],
  );

  const { data, isLoading } = useLiveQuery(
    (q) =>
      q.from({ item: collection }).orderBy(({ item }) => item._order, "asc"),
    [collection],
  );

  const turnResult = useSessionTurnResult(cliSessionId);

  return {
    collection,
    items: data ?? [],
    lastError: turnResult.lastError,
    isInitialLoading: isLoading,
    error: null as Error | null,
  };
}
