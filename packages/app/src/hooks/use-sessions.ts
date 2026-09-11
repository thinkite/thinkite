import { useLiveQuery } from "@tanstack/react-db";
import { useDaemonClient } from "@/lib/daemon-client-context";
import { ocSessionStateCollection } from "@/lib/sessions-collection";

/**
 * Reactive flat list of opencode sessions, sorted by `updatedAt` desc —
 * recency wins, no project grouping per [[project_v0_session_list_design]].
 *
 * Backed by the opencode `ses_*` collection (TanStack DB custom sync over
 * the `/api/session` page + shared `/api/event` bus, both through the iroh
 * HTTP tunnel). The collection is only synced while the daemon connection
 * is online (`OcRuntimeGate`); the `connectionStatus` guard returns a
 * `null` query while offline so this hook never starts sync from under
 * the gate.
 *
 * Returns the `useLiveQuery` shape — `{ data, isLoading, isReady,
 * isError, status }`; `data` is undefined while disabled (offline).
 */
export function useSessions() {
  const { connectionStatus } = useDaemonClient();
  const online = connectionStatus === "online";
  return useLiveQuery(
    (q) =>
      online
        ? q
            .from({ s: ocSessionStateCollection })
            .orderBy(({ s }) => s.updatedAt, "desc")
        : null,
    [online],
  );
}
