import { useQuery } from "@tanstack/react-query";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Curated model list for the input-bar picker. One round-trip on first
 * read; react-query caches for effectively the rest of the connection.
 *
 * staleTime: Infinity — daemon's MODEL_METADATA table is hardcoded and
 * only changes when the daemon process restarts (e.g. user updates the
 * Mac app), so re-fetching mid-session is pure waste. The next pair /
 * reconnect rebuilds the query client anyway.
 *
 * Disabled while the daemon client isn't ready — caller handles the
 * loading state by falling back to a placeholder label.
 */
export function useModels() {
  const { client } = useDaemonClient();
  return useQuery({
    queryKey: ["models"],
    queryFn: () => {
      if (!client) throw new Error("daemon client not ready");
      return client.getModels();
    },
    enabled: client !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
}
