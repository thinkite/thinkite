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
 * Post-facade: `client` is always non-null; calls queue internally
 * until the transport handshake completes. No `enabled` gate needed.
 */
export function useFilesystemRoots() {
  const { client } = useDaemonClient();
  return useQuery({
    queryKey: ["filesystemRoots"],
    queryFn: () => client.getFilesystemRoots(),
    staleTime: 30_000,
  });
}
