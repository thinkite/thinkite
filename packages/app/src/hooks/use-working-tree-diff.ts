import { useQuery } from "@tanstack/react-query";
import { getOcClient } from "@/lib/oc";
import { vcsKey } from "./use-git-status";

/**
 * The folder's diff for the status bar's tap target: opencode's `vcs.diff`
 * in branch mode, the same changes the bar counts and the desktop's diff
 * panel shows, one patch per file joined into one unified diff.
 *
 * `enabled` gates the fetch to when the diff sheet is open: the diff is
 * heavier than the bar's counts, so it isn't pulled for every session
 * screen.
 *
 * staleTime: Infinity: `useGitStatus` invalidates every `vcs` query of the
 * folder when the daemon's git watcher sees a change, which refetches this
 * one iff it is active (sheet open). Closed → marked stale → fresh on next
 * open. structuralSharing (on by default) keeps `data` referentially stable
 * across byte-identical refetches, so an unchanged refetch never
 * re-renders / re-tokenizes the webview.
 */
export function useWorkingTreeDiff(
  cwd: string | undefined,
  opts: { enabled: boolean },
) {
  return useQuery({
    queryKey: [...vcsKey(cwd ?? ""), "diff", "full"],
    queryFn: async (): Promise<{
      isRepo: boolean;
      diff: string;
      fileCount: number;
    }> => {
      if (!cwd) throw new Error("cwd required");
      const oc = getOcClient();
      if ((await oc.vcs(cwd)).provider === undefined)
        return { isRepo: false, diff: "", fileCount: 0 };
      // Three lines of context, as `git diff` gives: opencode's default is
      // the whole file, too much to render on a phone (a lockfile).
      const files = await oc.vcsDiff(cwd, "branch", 3);
      return {
        isRepo: true,
        diff: files.map((f) => f.patch).join("\n"),
        fileCount: files.length,
      };
    },
    enabled: opts.enabled && cwd !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
