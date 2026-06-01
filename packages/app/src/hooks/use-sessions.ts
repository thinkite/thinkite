import { eq, useLiveQuery } from "@tanstack/react-db";
import { sessionStateCollection } from "@/lib/sessions-collection";

/**
 * Reactive flat list of all visible (not archived) sessions, sorted by
 * `lastActivityAt` desc — recency wins, no project grouping per
 * [[project_v0_session_list_design]].
 *
 * Backed by the `sessionStateCollection` (TanStack DB custom sync
 * collection over the daemon's `subscribeSessions` push stream). The
 * collection survives transport reconnects; its sync handler awaits the
 * daemon transport's readyPromise on first attach, so no `enabled` gate
 * needed here.
 *
 * Returns the `useLiveQuery` shape — `{ data, isLoading, isReady,
 * isError, status }`. NOT the React Query shape: no `isPending`, no
 * `error` object (use `isLoading` / `isError` / `status`).
 */
export function useSessions() {
  return useLiveQuery((q) =>
    q
      .from({ s: sessionStateCollection })
      .where(({ s }) => eq(s.isArchived, false))
      .orderBy(({ s }) => s.lastActivityAt, "desc"),
  );
}
