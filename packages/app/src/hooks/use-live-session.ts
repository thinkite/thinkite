import { useEffect, useState } from "react";
import { useDaemonClient } from "@/lib/daemon-client-context";
import {
  applyDelta,
  applySettled,
  emptyTimelineState,
  type TimelineState,
} from "@/lib/timeline-reducer";

/**
 * Subscribe to a session's live timeline. On mount, calls daemon's
 * `subscribe` RPC which returns the settled snapshot (JSONL replay) +
 * registers a callback for live `EventDelta`s; unmount sends matching
 * `unsubscribe`. Returns the running `TimelineState` plus convenience
 * flags for the loading + error states.
 *
 * Supersedes `useMessages` for the transcript view. `useMessages` does a
 * one-shot cold-load via `getMessages`; `useLiveSession` rolls cold-load
 * + live tail into a single subscribe so the screen reflects new tokens
 * within ~200ms (the SDK iterator's delta cadence).
 *
 * Race / cleanup correctness:
 *   - The `active` flag guards against state updates after unmount (the
 *     `subscribe` Promise can resolve, or a delta can fire, after the
 *     effect's cleanup ran).
 *   - If the subscribe Promise resolves AFTER unmount, we still call the
 *     returned `unsubscribe` thunk — otherwise the daemon keeps fanning
 *     events to a callback whose owner is gone.
 *   - Daemon-client's `subscribe` is identity-checked: a stale unsubscribe
 *     after a quick remount won't clobber the new subscription.
 */
export function useLiveSession(cliSessionId: string) {
  const { client } = useDaemonClient();
  const [state, setState] = useState<TimelineState>(emptyTimelineState());
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!client) return;
    let active = true;
    let cleanup: (() => Promise<void>) | null = null;

    setIsInitialLoading(true);
    setError(null);
    setState(emptyTimelineState());

    client
      .subscribe(cliSessionId, (delta) => {
        if (!active) return;
        setState((prev) => applyDelta(prev, delta, prev.cursor + 1));
      })
      .then(({ settled, cursor, initialUsage, unsubscribe }) => {
        if (!active) {
          void unsubscribe();
          return;
        }
        // `initialUsage` seeds the context meter immediately on resume
        // (extracted by daemon from the JSONL's last assistant
        // message). Undefined = meter stays null until next live
        // turn_completed — fresh session, or last turn was tool-only.
        setState(applySettled(settled, cursor, initialUsage));
        setIsInitialLoading(false);
        cleanup = unsubscribe;
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setIsInitialLoading(false);
      });

    return () => {
      active = false;
      void cleanup?.();
    };
  }, [client, cliSessionId]);

  return {
    items: state.items,
    isRunning: state.isRunning,
    lastError: state.lastError,
    /** Usage snapshot from the most recent `turn_completed` delta. Null
     *  on first mount and on session re-subscribe — populated by the
     *  next completed turn. Drives the context meter on the model
     *  picker chip. See timeline-reducer.ts for the longer rationale. */
    latestUsage: state.latestUsage,
    isInitialLoading,
    error,
  };
}
