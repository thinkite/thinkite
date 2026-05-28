import {
  computeContextUsage,
  type ContextUsage,
} from "@/lib/context-usage";
import type { TurnUsage } from "@sidecodeapp/protocol";
import { useModels } from "@/hooks/use-models";

/**
 * Hook wrapper around `computeContextUsage`. Looks up the selected
 * model's `contextWindow` from the daemon catalog and feeds it to the
 * pure helper. Reactively re-runs when either input changes (the React
 * Query subscription on useModels handles the catalog half).
 *
 * Returns `null` when:
 *   - No model is selected yet (picker hasn't bootstrapped)
 *   - The model isn't in the catalog (e.g. user resumed a
 *     deprecated-model session; getModels filters those out — niche
 *     V0 acceptable gap)
 *   - No turn has completed yet (latestUsage null on fresh subscribe)
 *
 * See `lib/context-usage.ts` for the formula + design rationale.
 */
export type { ContextUsage };

export function useContextUsage(
  latestUsage: TurnUsage | null | undefined,
  model: string | undefined,
): ContextUsage | null {
  const { data: models } = useModels();
  if (!model) return null;
  const contextWindow = models?.find((m) => m.model === model)?.contextWindow;
  return computeContextUsage(latestUsage, contextWindow);
}
