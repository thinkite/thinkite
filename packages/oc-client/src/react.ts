/** React reads of an `OcStore`, one per thing a view shows. */

import type { FormInfo, PermissionRequest } from "@opencode/client";
import { useSelector } from "@tanstack/react-store";
import type { SessionInfo, SessionMessageInfo } from "./client.ts";
import type { ConnectionStatus, OcStore, Paging } from "./store/store.ts";

const EMPTY: readonly never[] = [];
const COLD: Paging = {
  cursor: undefined,
  hydrated: false,
  loadingOlder: false,
};

/** Root sessions, most recent first. */
export function useSessions(store: OcStore): readonly SessionInfo[] {
  return useSelector(store.rootSessions);
}

export function useSession(
  store: OcStore,
  sessionID: string | null,
): SessionInfo | undefined {
  return useSelector(store.session.info, (all) =>
    sessionID ? all[sessionID] : undefined,
  );
}

/** Ids of the sessions with a turn in flight. */
export function useRunning(store: OcStore): ReadonlySet<string> {
  return useSelector(store.running);
}

export function useIsRunning(
  store: OcStore,
  sessionID: string | null,
): boolean {
  return useSelector(store.session.active, (all) =>
    sessionID ? all[sessionID] === "running" : false,
  );
}

/** One session's transcript, oldest first. Other sessions' changes do not re-render. */
export function useMessages(
  store: OcStore,
  sessionID: string | null,
): readonly SessionMessageInfo[] {
  return useSelector(
    store.session.message,
    (all) => (sessionID ? all[sessionID] : undefined) ?? EMPTY,
  );
}

export function usePaging(store: OcStore, sessionID: string | null): Paging {
  return useSelector(
    store.session.paging,
    (all) => (sessionID ? all[sessionID] : undefined) ?? COLD,
  );
}

export function usePermissions(
  store: OcStore,
  sessionID: string | null,
): readonly PermissionRequest[] {
  return useSelector(
    store.session.permission,
    (all) => (sessionID ? all[sessionID] : undefined) ?? EMPTY,
  );
}

export function useForms(
  store: OcStore,
  sessionID: string | null,
): readonly FormInfo[] {
  return useSelector(
    store.session.form,
    (all) => (sessionID ? all[sessionID] : undefined) ?? EMPTY,
  );
}

/** Whether an answer to this permission request or form is on its way. */
export function useReplying(store: OcStore, id: string): boolean {
  return useSelector(store.replying, (all) => all[id] === true);
}

/** Whether the store has read the session list and follows the bus. */
export function useConnectionStatus(store: OcStore): ConnectionStatus {
  return useSelector(store.status, (s) => s.status);
}
