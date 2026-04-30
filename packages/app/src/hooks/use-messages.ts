import { useQuery } from "@tanstack/react-query";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Fetch a session's full transcript via the daemon (which proxies to the
 * SDK's `getSessionMessages`). The SDK does an all-projects scan to find
 * the JSONL — fork sessions have non-deterministic file locations and a
 * cwd hint isn't reliable, so we eat the ~20-stat scan cost instead.
 *
 * Wire shape is `unknown[]` (the protocol leaves `message: unknown` for
 * Slice C to narrow into ContentBlock-aware components). This hook is
 * agnostic to that decision — it just ships the array.
 */
export function useMessages(cliSessionId: string) {
  const { client } = useDaemonClient();
  return useQuery<unknown[]>({
    queryKey: ["messages", cliSessionId],
    queryFn: async () => client!.getMessages(cliSessionId),
    enabled: !!client,
  });
}
