import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useDaemonClient } from "@/lib/daemon-client-context";
import { getOcClient } from "@/lib/oc";

/** What the status bar shows for a folder. */
export interface RepoStatus {
  /** False when the folder isn't in a git repository. */
  isRepo: boolean;
  /** The folder's name. */
  project: string;
  /** Null when not a repo, or in detached-HEAD state. */
  branch: string | null;
  insertions: number;
  deletions: number;
}

/** Every opencode `vcs` read of a folder: one invalidation refreshes all. */
export const vcsKey = (cwd: string) => ["vcs", cwd] as const;

const basename = (cwd: string) => cwd.split("/").filter(Boolean).at(-1) ?? cwd;

/**
 * The folder's repository as the desktop's Changes card shows it, from
 * opencode's `vcs` (the branch) and `vcs.diff` in branch mode (everything
 * the branch changed since it left the default branch, uncommitted and
 * untracked files included), counted without context lines.
 *
 * opencode pushes no event for file changes, so the daemon's git watcher
 * is the change signal, as on the desktop (lib/git-events): each
 * `gitStatus` push reads every `vcs` query of the folder again (the diff
 * sheet's too, if open). The push's own numbers are not used. It is a
 * pass-through to the current transport, so the subscription is gated on
 * `connectionStatus` and made again after a reconnect.
 */
export function useGitStatus(cwd: string | undefined): RepoStatus | null {
  const { client, connectionStatus } = useDaemonClient();
  const queryClient = useQueryClient();
  const online = connectionStatus === "online";
  const enabled = cwd !== undefined && online;

  const info = useQuery({
    queryKey: [...vcsKey(cwd ?? ""), "info"],
    queryFn: () => getOcClient().vcs(cwd as string),
    enabled,
  });
  const isRepo =
    info.data === undefined ? undefined : info.data.provider !== undefined;
  const counts = useQuery({
    queryKey: [...vcsKey(cwd ?? ""), "diff", 0],
    queryFn: () => getOcClient().vcsDiff(cwd as string, "branch", 0),
    enabled: enabled && isRepo === true,
  });

  useEffect(() => {
    if (!enabled || cwd === undefined) return;
    let active = true;
    let unsub: (() => Promise<void>) | null = null;
    client
      .subscribeGitStatus(cwd, () => {
        if (active)
          void queryClient.invalidateQueries({ queryKey: vcsKey(cwd) });
      })
      .then(({ unsubscribe }) => {
        if (!active) return void unsubscribe().catch(() => {});
        unsub = unsubscribe;
      })
      .catch((err) => {
        if (active) console.error("subscribeGitStatus failed", err);
      });
    return () => {
      active = false;
      void unsub?.().catch(() => {});
    };
  }, [client, cwd, enabled, queryClient]);

  if (cwd === undefined || info.data === undefined) return null;
  const files = counts.data ?? [];
  return {
    isRepo: isRepo === true,
    project: basename(cwd),
    // `git rev-parse --abbrev-ref` says `heads/x` when a tag is also named x.
    branch: info.data.branch.current?.replace(/^heads\//, "") ?? null,
    insertions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}
