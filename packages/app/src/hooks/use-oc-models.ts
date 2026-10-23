import { useQuery } from "@tanstack/react-query";
import { formatModelRef, type ModelInfo } from "@thinkite/oc-client";
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

/** Provider id → display name, for the model picker's sections. Empty
 *  while offline. */
export function useOcProviders(): ReadonlyMap<string, string> {
  const { connectionStatus } = useDaemonClient();
  const { data } = useQuery({
    queryKey: ["ocProviders"],
    queryFn: async () => {
      const providers = await getOcClient().listProviders();
      return new Map(providers.map((p) => [p.id, p.name]));
    },
    enabled: connectionStatus === "online",
    staleTime: 5 * 60_000,
  });
  return data ?? EMPTY;
}
const EMPTY: ReadonlyMap<string, string> = new Map();

/**
 * The model a session in `directory` runs on when it names none (the
 * project's configured model, else the user's), as a `providerID/modelID`
 * ref. Null while loading, offline or with no directory.
 */
export function useOcDefaultModel(
  directory: string | undefined,
): string | null {
  const { connectionStatus } = useDaemonClient();
  const { data } = useQuery({
    queryKey: ["ocDefaultModel", directory],
    queryFn: async () => {
      const m = await getOcClient().defaultModel(directory);
      return m ? formatModelRef(m.providerID, m.id) : null;
    },
    enabled: connectionStatus === "online" && directory !== undefined,
    staleTime: 5 * 60_000,
  });
  return data ?? null;
}
