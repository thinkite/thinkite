import type { TimelineItem } from "@sidecodeapp/protocol";
import { useQuery } from "@tanstack/react-query";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Fetch a session's full transcript via the daemon. Daemon proxies to the
 * SDK's `getSessionMessages` and runs Slice D normalization to flatten the
 * Anthropic ContentBlock[] / pair tool_use+tool_result into a typed
 * `TimelineItem[]`. iOS doesn't see the raw SDK shape — see
 * daemon/src/messages/normalize.ts.
 *
 * No cwd hint: SDK scans every project key (~20 stat calls). Robust against
 * fork sessions where the JSONL location varies between worktree and
 * originCwd project keys.
 */
export function useMessages(cliSessionId: string) {
  const { client } = useDaemonClient();
  return useQuery<TimelineItem[]>({
    queryKey: ["messages", cliSessionId],
    queryFn: async () => client!.getMessages(cliSessionId),
    enabled: !!client,
  });
}
