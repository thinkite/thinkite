import { useQuery } from "@tanstack/react-query";
import { useDaemonClient } from "@/lib/daemon-client-context";
import type { SessionInfo } from "@/types/session";

/**
 * Fetch all sessions from the daemon. iOS groups by `cwd` client-side
 * (see SessionsScreen). The daemon walks every Desktop env-pair under
 * `claude-code-sessions/`; we don't filter on the wire.
 *
 * Daemon connection is owned by `<DaemonClientProvider>`, which handshakes
 * eagerly on mount. Post-facade refactor `client` is always non-null and
 * the listSessions call awaits the transport's readyPromise internally,
 * so no `enabled` gate is needed — the first call after mount blocks
 * until the handshake completes.
 */
export function useSessions() {
  const { client } = useDaemonClient();
  return useQuery<SessionInfo[]>({
    queryKey: ["sessions"],
    queryFn: async () => {
      const raw = await client.listSessions();
      return raw as SessionInfo[];
    },
  });
}
