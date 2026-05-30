import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { useDaemonClient } from "@/lib/daemon-client-context";
import { useSessionActivity } from "@/lib/session-activity";
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
 * 2. Turn-machine state (isRunning / lastError / latestUsage) lives in a
 *    separate `localOnly` collection (`@/lib/session-activity`), written
 *    by the transcript sync handler and read here via `useSessionActivity`
 *    — kept OFF the transcript collection (it's not "an item") and out of
 *    the server-authoritative sessions list (a refetch would clobber it).
 *
 * 3. `useLiveQuery.isLoading` is now the authoritative loading signal
 *    — flips false when the sync handler calls `markReady()` after
 *    first onSubscribed. No hand-rolled `isInitialLoading` useState.
 *
 * Return shape preserved for drop-in compatibility with the old
 * `useLiveSession` call sites:
 *   - `items` / `isInitialLoading`
 *   - `isRunning` / `lastError` / `latestUsage`
 *   - `error` (terminal subscribe failure — none today since the
 *     facade retries forever; field kept for API compat, always null)
 */
export function useSessionTranscript(cliSessionId: string) {
  const { client } = useDaemonClient();

  const collection = useMemo(
    () => getTranscriptCollection(cliSessionId, { client }),
    [cliSessionId, client],
  );

  const { data, isLoading } = useLiveQuery(
    (q) =>
      q.from({ item: collection }).orderBy(({ item }) => item._order, "asc"),
    [collection],
  );

  const activity = useSessionActivity(cliSessionId);

  return {
    items: data ?? [],
    isRunning: activity.isRunning,
    lastError: activity.lastError,
    latestUsage: activity.latestUsage,
    isInitialLoading: isLoading,
    error: null as Error | null,
  };
}
