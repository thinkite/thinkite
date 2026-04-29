import { useQuery } from "@tanstack/react-query";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Fetch a session's full transcript via the daemon (which proxies to the
 * SDK's `getSessionMessages`). `cwd` is required because the daemon command
 * is — without it the SDK falls back to an all-projects scan, and we
 * always have it on hand from the SessionInfo that drove this navigation.
 *
 * Wire shape is `unknown[]` (the protocol leaves `message: unknown` for
 * Slice C to narrow into ContentBlock-aware components). This hook is
 * agnostic to that decision — it just ships the array.
 */
export function useMessages(cliSessionId: string, cwd: string) {
  const { client } = useDaemonClient();
  return useQuery<unknown[]>({
    queryKey: ["messages", cliSessionId],
    queryFn: async () => client!.getMessages(cliSessionId, cwd),
    enabled: !!client,
  });
}
