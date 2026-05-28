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
 * Post-facade: `client` is always non-null and queues calls internally
 * until the transport handshake completes — no `enabled` gate needed.
 * react-query's queryFn awaits client.getModels which awaits the
 * facade's readyPromise; first call after mount just sits in flight
 * until the connection is up.
 */
export function useModels() {
  const { client } = useDaemonClient();
  return useQuery({
    queryKey: ["models"],
    queryFn: () => client.getModels(),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
