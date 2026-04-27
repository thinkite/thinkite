import { useQuery } from "@tanstack/react-query";
import { useDaemonClient } from "@/lib/daemon-client-context";
import type { SessionInfo } from "@/types/session";

/**
 * Fetch all sessions from the daemon. iOS groups by `cwd` client-side
 * (see SessionsScreen). The daemon walks every Desktop env-pair under
 * `claude-code-sessions/`; we don't filter on the wire.
 *
 * The DaemonClient is owned by `<DaemonClientProvider>` — first useQuery
 * call triggers the WS handshake; the live connection is shared across
 * every consumer until the provider unmounts or `daemon.reset()` is called.
 */
export function useSessions() {
  const daemon = useDaemonClient();
  return useQuery<SessionInfo[]>({
    queryKey: ["sessions"],
    queryFn: async () => {
      const client = await daemon.get();
      const raw = await client.listSessions();
      return raw as SessionInfo[];
    },
  });
}
