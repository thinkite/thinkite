import { useLiveQuery } from "@tanstack/react-db";
import { sessionsCollection } from "@/lib/sessions-collection";

/**
 * Reactive list of all sessions, read from the sessions TanStack DB
 * collection (a module singleton backed by the `listSessions` RPC — see
 * `sessions-collection.ts`). The daemon walks every Desktop env-pair
 * under `claude-code-sessions/` plus sidecode's own metadata; we don't
 * filter on the wire and group by project client-side (SessionListSidebar).
 *
 * Returns the `useLiveQuery` shape — `{ data, isLoading, isReady,
 * isError, status }`. NOT the React Query shape: no `isPending`, no
 * `error` object (use `isLoading` / `isError` / `status`). Sorted
 * recent-first so per-project groups render newest sessions at the top.
 *
 * The collection's queryFn awaits the daemon transport's readyPromise
 * internally, so the first fetch blocks until the handshake completes —
 * no `enabled` gate needed.
 */
export function useSessions() {
  return useLiveQuery((q) =>
    q
      .from({ s: sessionsCollection })
      .orderBy(({ s }) => s.lastActivityAt, "desc"),
  );
}
