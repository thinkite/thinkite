import { useQuery } from "@tanstack/react-query";
import type { ModelInfo } from "@thinkite/oc-client";
import { useDaemonClient } from "@/lib/daemon-client-context";
import { getOcClient } from "@/lib/oc";

/**
 * The models the user's opencode service offers (its connected providers),
 * minus disabled and deprecated ones, by name. Empty while offline.
 */
export function useOcModels(): ModelInfo[] {
  const { connectionStatus } = useDaemonClient();
  const { data } = useQuery({
    queryKey: ["ocModels"],
    queryFn: async () => {
      const models = await getOcClient().listModels();
      return models
        .filter((m) => m.enabled && m.status !== "deprecated")
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    enabled: connectionStatus === "online",
    staleTime: 5 * 60_000,
  });
  return data ?? [];
}
