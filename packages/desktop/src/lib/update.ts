import { useQuery } from "@tanstack/react-query";
import { queryClient } from "./query";

// The app's own update, as the main process's electron-updater reports it
// (server/updater.ts, through /api/update): the sidebar's update button and
// Settings → About read it. Downloads start on their own; the window only
// shows progress and offers the restart.

/** Must match server/updater's UpdateState. */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "up-to-date" }
  | { status: "downloading"; version: string; percent: number }
  | { status: "downloaded"; version: string }
  | { status: "installing"; version: string }
  | { status: "error"; message: string; version?: string };

/** Must match server/updater's UpdateInfo. */
export interface UpdateInfo {
  version: string;
  packaged: boolean;
  state: UpdateState;
  /** A version an earlier restart was meant to install but didn't. */
  notApplied?: string;
}

const updateKey = ["update"] as const;

const BUSY = new Set<UpdateState["status"]>([
  "checking",
  "downloading",
  "installing",
]);

/** Read every second while something is moving, else every half minute. */
export function useUpdate(): UpdateInfo | null {
  const { data } = useQuery({
    queryKey: updateKey,
    queryFn: () =>
      fetch("/api/update").then((res) => res.json() as Promise<UpdateInfo>),
    refetchInterval: (query) =>
      query.state.data && BUSY.has(query.state.data.state.status)
        ? 1000
        : 30_000,
  });
  return data ?? null;
}

function post(path: string): Promise<void> {
  return fetch(path, { method: "POST" })
    .then((res) => res.json() as Promise<UpdateInfo>)
    .then((info) => {
      queryClient.setQueryData(updateKey, info);
    });
}

export const checkForUpdate = () => post("/api/update/check");
export const installUpdate = () => post("/api/update/install");

/** The version a restart installs: one downloaded, or one kept by a failed
 *  install. */
export function readyVersion(state: UpdateState): string | undefined {
  return state.status === "downloaded" ||
    (state.status === "error" && state.version !== undefined)
    ? state.version
    : undefined;
}
