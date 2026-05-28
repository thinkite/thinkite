import { useQuery } from "@tanstack/react-query";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * One level of directory listing for the cwd picker. Folders only by
 * default (V0 — `includeFiles` deferred to V0.5 along with per-entry
 * stat fetching). Keyed by `path`, so navigating into a subfolder
 * triggers a fresh fetch instead of reusing the parent's result.
 *
 * staleTime: 30s — folders don't churn in the seconds between picker
 * opens; we'd rather show the recently-cached list instantly than wait
 * for a network round-trip on every re-render.
 *
 * Disabled when `path` is undefined (caller's `currentPath` is still
 * resolving from `useFilesystemRoots`) — the cwd-picker screen renders
 * a loading placeholder during that window.
 */
export function useListDirectory(path: string | undefined) {
  const { client } = useDaemonClient();
  return useQuery({
    queryKey: ["listDirectory", path],
    queryFn: () => {
      if (!path) throw new Error("path required");
      return client.listDirectory(path);
    },
    enabled: path !== undefined,
    staleTime: 30_000,
  });
}
