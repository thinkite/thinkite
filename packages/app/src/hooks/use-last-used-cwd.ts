import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getLastUsedCwd, setLastUsedCwd } from "@/lib/last-used-cwd";

/**
 * Read + mutate the persisted "last-used cwd" via react-query so all
 * consumers (new-session screen default, picker pre-selection,
 * post-send refresh) stay in sync.
 *
 * Layout:
 *   - `useLastUsedCwd()` — read hook; null while loading or never set.
 *   - `useSetLastUsedCwd()` — mutation hook; persists + invalidates
 *     the query so subscribers re-read immediately.
 *
 * staleTime: Infinity — the only thing that changes this value is the
 * explicit setter, so polling / refetch-on-focus is pure noise.
 */

const QUERY_KEY = ["lastUsedCwd"] as const;

export function useLastUsedCwd() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: getLastUsedCwd,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

export function useSetLastUsedCwd() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: setLastUsedCwd,
    onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });
}
