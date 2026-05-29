import { useCallback } from "react";
import type { ModelSelection } from "@/components/transcript/input-bar";
import { sessionsCollection } from "@/lib/sessions-collection";

/**
 * Commit the input-bar picker's model selection for a session.
 *
 * `collection.update` applies the new model optimistically to the sessions
 * collection (chip + list row update instantly), then the collection's
 * `onUpdate` handler fires the `setSessionSelection` RPC and query-db
 * refetches to confirm. On RPC failure the optimistic update is rolled
 * back automatically — no manual snapshot/restore.
 *
 * Returns a `{ mutate }` shape so existing call sites (detail screen's
 * `onSelectionChange`, the `/model` slash handler) are unchanged.
 */
export function useSetSessionSelection(cliSessionId: string) {
  const mutate = useCallback(
    (selection: ModelSelection) => {
      // New-session context passes "" (the slash handler calls the hook
      // unconditionally to honor rules-of-hooks but never mutates there).
      if (!cliSessionId) return;
      // No row yet (session not in the collection) → nothing to update,
      // and collection.update on a missing key throws. The model is still
      // seeded via sendPrompt, so skipping here is safe.
      if (sessionsCollection.get(cliSessionId) === undefined) return;
      sessionsCollection.update(cliSessionId, (draft) => {
        draft.model = selection.model;
      });
    },
    [cliSessionId],
  );

  return { mutate };
}
