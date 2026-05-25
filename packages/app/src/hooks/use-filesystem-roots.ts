import { useQuery } from "@tanstack/react-query";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Bootstrap roots + recents for the cwd picker. Single round-trip on
 * first read; react-query caches the result for the rest of the
 * session.
 *
 * staleTime: 30s — recents can shift between calls (user opens an
 * older session via Desktop while iOS is in foreground), but
 * snapshotting them per picker-open is fresh enough; we don't need
 * live updates.
 *
 * Disabled while the daemon client isn't ready — caller (new-session
 * screen) handles the "no data yet" UI state separately.
 */
export function useFilesystemRoots() {
  const { client } = useDaemonClient();
  return useQuery({
    queryKey: ["filesystemRoots"],
    queryFn: () => {
      if (!client) throw new Error("daemon client not ready");
      return client.getFilesystemRoots();
    },
    enabled: client !== null,
    staleTime: 30_000,
  });
}
