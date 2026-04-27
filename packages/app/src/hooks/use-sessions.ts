import { useQuery } from "@tanstack/react-query";
import { useDaemonClient } from "@/lib/daemon-client-context";
import type { SessionInfo } from "@/types/session";

/**
 * Fetch all sessions from the daemon. iOS groups by `cwd` client-side
 * (see SessionsScreen). The daemon walks every Desktop env-pair under
 * `claude-code-sessions/`; we don't filter on the wire.
 *
 * Daemon connection is owned by `<DaemonClientProvider>`, which handshakes
 * eagerly on mount. The root layout gates the tree behind a splash until
 * `client` is ready, so in practice this query runs with a live connection
 * the first time it mounts. The `enabled` guard is just defense for the
 * brief window after `reset()` when we're handshaking again.
 */
export function useSessions() {
  const { client } = useDaemonClient();
  return useQuery<SessionInfo[]>({
    queryKey: ["sessions"],
    queryFn: async () => {
      const raw = await client!.listSessions();
      return raw as SessionInfo[];
    },
    enabled: !!client,
  });
}
