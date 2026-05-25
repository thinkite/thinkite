import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useDaemonClient } from "@/lib/daemon-client-context";
import type { SessionInfo } from "@/types/session";
import type { ModelSelection } from "@/components/transcript/input-bar";

/**
 * Commit the input-bar picker's model + effort selection for a session.
 *
 * Optimistic mutation flow:
 *   1. `onMutate` snapshots the current `["sessions"]` cache and writes
 *      the new selection straight into the matching entry — the chip,
 *      session list, and anything else reading the cache update with
 *      zero RPC latency.
 *   2. `mutationFn` fires `client.setSessionSelection`. Daemon applies
 *      to the live SDK query first; only writes metadata on success.
 *      On apply failure the daemon returns an `error` frame and our
 *      `request()` promise rejects.
 *   3. `onError` restores the cache from the snapshot — chip reverts
 *      automatically; no separate "rollback selection" UI logic.
 *
 * Race control: `cancelQueries` in `onMutate` is the standard pattern.
 * When the user spam-picks A → B → C, each onMutate runs in order; the
 * later optimistic write supersedes the earlier; if one rejects, its
 * `context.previous` (which captured B's optimistic value, etc.)
 * cascades the rollback back to the last-known-good state.
 */
export function useSetSessionSelection(cliSessionId: string) {
  const { client } = useDaemonClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (selection: ModelSelection) => {
      if (!client) throw new Error("daemon client not ready");
      await client.setSessionSelection({
        sessionId: cliSessionId,
        model: selection.model,
        effort: selection.effort,
      });
    },
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: ["sessions"] });
      const previous = queryClient.getQueryData<SessionInfo[]>(["sessions"]);
      queryClient.setQueryData<SessionInfo[]>(["sessions"], (old) =>
        (old ?? []).map((s) =>
          s.cliSessionId === cliSessionId
            ? { ...s, model: next.model, effort: next.effort }
            : s,
        ),
      );
      return { previous };
    },
    onError: (_err, _next, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["sessions"], context.previous);
      }
    },
    // No onSettled → no automatic refetch. Daemon's setSessionSelection
    // handler is atomic (write only on apply success), so cache reflects
    // daemon truth without an extra round-trip. Add an invalidate later
    // if we ever see drift.
  });
}
