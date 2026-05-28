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
 * Reactive per-session transcript binding, backed by a TanStack DB
 * QueryCollection + the facade's auto-resume Subscription.
 *
 * Architecture decisions:
 *
 * 1. **Per-session collection via module-level factory**
 *    (`getTranscriptCollection`). Maintainer-blessed pattern from
 *    TanStack/db#652 — one collection per cliSessionId, Map cache
 *    keyed by sessionId, auto-evict on `status:change` cleaned-up.
 *
 * 2. **Stable facade — collection survives reconnect**. The facade
 *    refactor means `client` is the same instance for the Provider's
 *    lifetime; the underlying Transport gets swapped on reconnect
 *    transparently. So the collection's useMemo no longer takes
 *    `client` as a dep — it only re-creates on cliSessionId change.
 *    This removes the old `QueryBuilderError: Invalid source for
 *    live query` race where a brief null window during reconnect
 *    would crash useLiveQuery.
 *
 * 3. **Auto-resume via facade Subscription**. The facade's
 *    `client.subscribe(...)` returns a long-lived Subscription that
 *    survives transport reconnects: it keeps the per-sub cursor +
 *    epoch and re-issues subscribe RPCs against fresh transports
 *    with those resume hints. Daemon serves the gap incrementally
 *    when it can; falls back to a full snapshot (recovered:false)
 *    when it can't (epoch mismatch from daemon restart, OR
 *    sinceCursor predates the runtime ring buffer). The
 *    `onSubscribed` callback's `recovered` flag tells us which
 *    happened, and we truncate+ingest on cold path or keep going on
 *    warm.
 *
 * 4. **No useEffect cleanup() call on the collection**. TanStack DB's
 *    `gcTime` config (60s in our factory) handles the "no subscribers
 *    → wait → clean up" lifecycle.
 *
 * 5. **Turn lifecycle (isRunning / lastError / latestUsage) lives
 *    OUTSIDE the collection** as plain useState. These are per-
 *    session state, not items — folding them into the collection
 *    would force a tagged "control row" or a second collection just
 *    for state. Cheap useState in the hook is the right level.
 *
 * 6. **Subscribe writes use `collection.utils.writeXxx`**, not
 *    `collection.update()`. The latter is the optimistic-mutation
 *    entry point and requires an `onUpdate` handler — for SDK-pushed
 *    events that are already canonical, direct writes bypass the
 *    optimistic system. Optimistic insert for user-typed prompts
 *    lands in Phase 3.
 *
 * Return shape mirrors the old `useLiveSession` for drop-in
 * compatibility at the call site:
 *   - `items` / `isInitialLoading`
 *   - `isRunning` / `lastError` / `latestUsage`
 *   - `error` (terminal subscribe failure — none today; field kept
 *     for API compat, always null)
 */
export function useSessionTranscript(cliSessionId: string) {
  const { client } = useDaemonClient();
  const queryClient = useQueryClient();

  // Collection lifetime tracks cliSessionId only — `client` is stable
  // post-facade refactor, so no need to gate on it. Factory returns
  // the same instance across hook re-renders for a given sessionId
  // (Map cache); evicts after gcTime when no subscribers.
  const collection = useMemo(
    () => getTranscriptCollection(cliSessionId, { client, queryClient }),
    [cliSessionId, client, queryClient],
  );

  const { data, isLoading: liveQueryLoading } = useLiveQuery(
    (q) =>
      q.from({ item: collection }).orderBy(({ item }) => item._order, "asc"),
    [collection],
  );
  const items = data ?? [];

  // Turn lifecycle state — driven by subscribe callback below.
  const [isRunning, setIsRunning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [latestUsage, setLatestUsage] = useState<TurnUsage | null>(null);
  // `error` is kept for API compatibility with the old useLiveSession
  // return shape, but the facade now retries forever — no terminal
  // failure surface from this hook. Always null until we add real
  // terminal cases (permission denied / session not found).
  const [error] = useState<Error | null>(null);
  // Subscription-loading gate: separate from useLiveQuery's hydration
  // so the consumer can distinguish "collection hasn't hydrated yet"
  // (data is empty array) from "first subscribe response landed and
  // we're catching up to live" (settled has been ingested).
  const [isSubLoading, setIsSubLoading] = useState(true);

  const isInitialLoading = liveQueryLoading || isSubLoading;

  // Subscribe via the stable facade. The returned Subscription survives
  // every transport reconnect — facade re-attaches with our sinceCursor
  // + sinceEpoch and replays the gap automatically. We only need to
  // unsubscribe on unmount + sessionId change.
  useEffect(() => {
    let active = true;
    setIsSubLoading(true);

    const sub = client.subscribe(cliSessionId, {
      onEvent: (delta) => {
        if (!active) return;
        // writeBatch coalesces multiple writes into one collection
        // change event — harmless for single deltas, matches the
        // WebSocket example pattern from TanStack docs.
        collection.utils.writeBatch(() => {
          switch (delta.kind) {
            case "append": {
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
              // no-ops at the items level (compact_applied would prune
              // + append divider when ready).
              break;
          }
        });
      },
      onSubscribed: ({ recovered, settled, initialUsage }) => {
        if (!active) return;
        if (!recovered) {
          // Cold path — daemon returned a full snapshot. Truncate the
          // collection and ingest `settled` from scratch. Triggers on
          // first subscribe AND on reconnect when daemon couldn't
          // serve incrementally (epoch mismatch from daemon restart,
          // or sinceCursor predates the ring buffer).
          //
          // The first-subscribe case looks redundant: queryFn already
          // populated the collection with the SAME data (both read the
          // JSONL via daemon's getMessages). But the daemon's settled
          // is taken atomically with the live-fanout attach, while
          // queryFn ran at a different moment — settled is the
          // authoritative "starting point" of the live stream. Worst-
          // case flash is one React re-render with identical content.
          //
          // Materialize keys BEFORE writeBatch to avoid iterator
          // invalidation when we then mutate the collection. Then do
          // delete-all + re-insert-all in one batch so the UI sees a
          // single change event.
          const keysToDelete: string[] = [];
          for (const item of collection.values()) {
            keysToDelete.push(
              item.type === "tool_call" ? item.callId : item.uuid,
            );
          }
          collection.utils.writeBatch(() => {
            for (const key of keysToDelete) {
              collection.utils.writeDelete(key);
            }
            for (let i = 0; i < settled.length; i += 1) {
              collection.utils.writeInsert({ ...settled[i], _order: i });
            }
          });
        }
        // Warm path: keep the collection as-is. The replay events for
        // the gap (sinceCursor, response.cursor] will arrive via
        // onEvent right after this callback returns.
        if (initialUsage !== undefined) setLatestUsage(initialUsage);
        setIsSubLoading(false);
      },
    });

    return () => {
      active = false;
      void sub.unsubscribe();
    };
  }, [client, cliSessionId, collection]);

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
