/** React reads of an `OcStore`, one per thing a view shows. */

import type { FormInfo, PermissionRequest } from "@opencode/client";
import { useSelector } from "@tanstack/react-store";
import type { SessionInfo, SessionMessageInfo } from "./client.ts";
import { formatModelRef } from "./model-ref.ts";
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

/** The last used model as a `providerID/modelID` ref, or null if none. */
export function useLastUsedModel(store: OcStore): string | null {
  return useSelector(store.lastUsedModel, (m) =>
    m ? formatModelRef(m.providerID, m.id) : null,
  );
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

/** Permission requests waiting in the session or its subagents. */
export function usePermissions(
  store: OcStore,
  sessionID: string | null,
): readonly PermissionRequest[] {
  return useSelector(
    store.pending,
    (all) => (sessionID ? all[sessionID]?.permissions : undefined) ?? EMPTY,
  );
}

/** Questions waiting in the session or its subagents. */
export function useForms(
  store: OcStore,
  sessionID: string | null,
): readonly FormInfo[] {
  return useSelector(
    store.pending,
    (all) => (sessionID ? all[sessionID]?.forms : undefined) ?? EMPTY,
  );
}

/** Root sessions with a permission request or question waiting. */
export function useWaiting(store: OcStore): ReadonlySet<string> {
  return useSelector(store.pending, (all) => new Set(Object.keys(all)), {
    compare: (a, b) => a.size === b.size && [...a].every((id) => b.has(id)),
  });
}

/** Sessions whose last turn failed. */
export function useFailed(store: OcStore): Readonly<Record<string, true>> {
  return useSelector(store.session.failed);
}

/** Whether an answer to this permission request or form is on its way. */
export function useReplying(store: OcStore, id: string): boolean {
  return useSelector(store.replying, (all) => all[id] === true);
}

/** Whether the store has read the session list and follows the bus. */
export function useConnectionStatus(store: OcStore): ConnectionStatus {
  return useSelector(store.status, (s) => s.status);
}
