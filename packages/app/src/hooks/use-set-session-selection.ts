import { useCallback } from "react";
import type { ModelSelection } from "@/components/transcript/input-bar";
import { updateSessionModel } from "@/lib/sessions-collection";

/**
 * Commit the input-bar picker's model selection for a session.
 *
 * Delegates to the `updateSessionModel` optimistic action: applies the
 * new model optimistically to the row (chip + list row update instantly),
 * then fires the daemon's `setSessionSelection` RPC. The daemon mirrors
 * to `runtime.setModel` which broadcasts via #17 — the push fold-in
 * lands the canonical state as the optimistic drops.
 *
 * On RPC failure the optimistic update rolls back automatically. The
 * returned `{ mutate }` shape keeps existing call sites unchanged
 * (detail screen's `onSelectionChange`, the `/model` slash handler).
 */
export function useSetSessionSelection(cliSessionId: string) {
  const mutate = useCallback(
    (selection: ModelSelection) => {
      // New-session context passes "" (the slash handler calls the hook
      // unconditionally to honor rules-of-hooks but never mutates there).
      if (!cliSessionId) return;
      updateSessionModel({
        cliSessionId,
        model: selection.model,
      });
    },
    [cliSessionId],
  );

  return { mutate };
}
