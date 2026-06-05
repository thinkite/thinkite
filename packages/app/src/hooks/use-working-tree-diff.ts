import { useQuery } from "@tanstack/react-query";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Working-tree diff for `cwd` (the status bar's tap target), as a one-shot RPC
 * wrapped in react-query — same shape as `use-list-directory`. NOT a TanStack
 * DB collection: the diff is a whole-snapshot, not incrementally-synced data.
 *
 * `enabled` gates the fetch to when the diff sheet is open — the diff is
 * heavier than the always-on `+N -M` status subscription, so we don't pull it
 * for every session screen.
 *
 * staleTime: Infinity — the diff is a pure function of the working tree, and
 * the live `gitStatus` subscription is the change signal: `GitStatusBar`
 * invalidates `["workingTreeDiff", cwd]` whenever status changes, which
 * refetches iff this query is active (sheet open). Closed → marked stale →
 * fresh on next open. structuralSharing (on by default) keeps `data`
 * referentially stable across byte-identical refetches, so an unchanged
 * refetch never re-renders / re-tokenizes the webview.
 */
export function useWorkingTreeDiff(
  cwd: string | undefined,
  opts: { enabled: boolean },
) {
  const { client } = useDaemonClient();
  return useQuery({
    queryKey: ["workingTreeDiff", cwd],
    queryFn: () => {
      if (!cwd) throw new Error("cwd required");
      return client.getWorkingTreeDiff(cwd);
    },
    enabled: opts.enabled && cwd !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
