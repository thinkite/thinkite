import { useSelector } from "@tanstack/react-store";
import {
  useSessions as useOcSessions,
  useRunning,
} from "@thinkite/oc-client/react";
import { useMemo } from "react";
import { useDaemonClient } from "@/lib/daemon-client-context";
import { ocStore } from "@/lib/oc";

/** What a session list row shows. */
export interface OcSessionRow {
  id: string;
  title: string;
  directory: string;
  updatedAt: number;
  running: boolean;
}

/**
 * Flat list of opencode sessions, most recently updated first — recency
 * wins, no project grouping per [[project_v0_session_list_design]].
 *
 * Backed by the oc-client store (the `/api/session` list plus the shared
 * `/api/event` bus, both through the iroh HTTP tunnel), which only runs
 * while the daemon connection is online (`OcRuntimeGate`). `data` is
 * undefined while offline.
 */
export function useSessions(): {
  data: OcSessionRow[] | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const { connectionStatus } = useDaemonClient();
  const online = connectionStatus === "online";
  const sessions = useOcSessions(ocStore);
  const running = useRunning(ocStore);
  const status = useSelector(ocStore.status, (s) => s.status);
  const data = useMemo(
    () =>
      sessions.map((s) => ({
        id: s.id,
        title: s.title ?? "",
        directory: s.location.directory,
        updatedAt: s.time.updated,
        running: running.has(s.id),
      })),
    [sessions, running],
  );
  return {
    data: online ? data : undefined,
    isLoading: online && (status === "idle" || status === "connecting"),
    isError: online && status === "error",
  };
}
