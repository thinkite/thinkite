import { createCollection } from "@tanstack/react-db";
import {
  applySessionListEvent,
  applySessionListPage,
  createInitialSessionListState,
  type OcSessionItem,
  type OcSessionListState,
  ocStatusTransition,
} from "@thinkite/oc-client";
import { formatModelRef, getOcClient, sharedOcBus } from "./oc";
import { registerSessionStatusSink } from "./session-status";

/**
 * Desktop row for the session-states collection — keyed by the opencode
 * `ses_*` id, which is THE session id everywhere (routes, PTY keys,
 * transcript collections). Fed by `@thinkite/oc-client`'s session-list
 * reducer: initial `/api/session` page(s), then the shared `/api/event`
 * bus (`session.created/updated/deleted` for the list, turn-boundary
 * events for busy/idle via the shared `ocStatusTransition`). No polling
 * anywhere (the one `/api/session/active` read at startup seeds turns
 * already running — a resume read, like history).
 *
 * Sync contract (same as before): every (re)connect delivers a fresh
 * ground truth — truncate + bulk insert so rows removed while
 * disconnected don't linger; live bus events upsert / delete row-by-row.
 * Last-write-wins, no cursor.
 *
 * `startSync: true` keeps the collection warm from app start; route
 * loaders gate on `preload()` before reading.
 */
export type SessionRow = {
  /** opencode `ses_*` id — the route param and PTY key. */
  id: string;
  title: string;
  /** `location.directory` — cwd for TerminalPane/DiffPanel. */
  directory: string;
  /** `providerID/modelID`, null when the session reports none. */
  model: string | null;
  updatedAt: number;
  /** Turn-boundary busy/idle (`ocStatusTransition`); idle until seen. */
  activity: "running" | "idle";
};

function toRow(item: OcSessionItem, status: "busy" | "idle"): SessionRow {
  return {
    id: item.id,
    title: item.title,
    directory: item.directory,
    model:
      item.model !== undefined
        ? formatModelRef(item.model.providerID, item.model.id)
        : null,
    updatedAt: item.updatedAt,
    activity: status === "busy" ? "running" : "idle",
  };
}

function sessionIdOf(event: { data?: unknown }): string | undefined {
  const data = event.data as { sessionID?: unknown; info?: unknown };
  if (typeof data?.sessionID === "string") return data.sessionID;
  const info = data?.info as { id?: unknown };
  return typeof info?.id === "string" ? info.id : undefined;
}

export const sessionStateCollection = createCollection<SessionRow, string>({
  id: "session-states",
  getKey: (r) => r.id,
  startSync: true,
  sync: {
    sync: ({ begin, write, commit, markReady, truncate, collection }) => {
      let hasMarkedReady = false;
      let disposed = false;
      // The pure list reducer is the merge truth; the collection mirrors
      // it row-by-row. Bus-driven busy/idle layers on top (the list
      // payloads own title/directory/model, never status).
      let listState: OcSessionListState = createInitialSessionListState();
      const statusById = new Map<string, "busy" | "idle">();

      const setStatus = (id: string, status: "busy" | "idle") => {
        if (statusById.get(id) === status) return;
        statusById.set(id, status);
        const current = collection.get(id);
        // Unknown sessions are ignored — the list event creating them
        // arrives on the same bus and mirrors with status applied.
        if (current === undefined) return;
        begin();
        write({
          type: "update",
          value: {
            ...current,
            activity: status === "busy" ? "running" : "idle",
          },
        });
        commit();
      };

      const mirrorId = (id: string) => {
        const item = listState.items.find((s) => s.id === id);
        const existing = collection.get(id);
        begin();
        if (item === undefined) {
          statusById.delete(id);
          if (existing !== undefined) write({ type: "delete", key: id });
        } else {
          write({
            type: existing === undefined ? "insert" : "update",
            value: toRow(item, statusById.get(id) ?? "idle"),
          });
        }
        commit();
      };

      const unsubscribeBus = sharedOcBus.subscribe((event) => {
        if (disposed) return;
        if (
          event.type === "session.created" ||
          event.type === "session.updated" ||
          event.type === "session.deleted"
        ) {
          const id = sessionIdOf(event);
          listState = applySessionListEvent(listState, {
            type: event.type,
            data: event.data as unknown,
          });
          if (id !== undefined) mirrorId(id);
          return;
        }
        // Busy/idle from the same turn-boundary rules as the transcript
        // reducer (single source: `ocStatusTransition`) — the v2 engine
        // emits no `session.status` in 1.18.30, so the step rules do the
        // work and `session.status` overrides when present.
        const transition = ocStatusTransition({
          type: event.type,
          data: event.data as unknown,
        });
        if (transition === null) return;
        const data = event.data as { sessionID?: unknown };
        if (typeof data?.sessionID !== "string") return;
        setStatus(data.sessionID, transition);
      });

      // The open session's durable stream is the authoritative source for
      // its own busy/idle (session-status.ts) — same write path as the bus.
      const unregisterSink = registerSessionStatusSink(setStatus);

      // Initial page(s), then ready. A bus event racing the snapshot
      // applies to listState first and mirrors after — an interleaved
      // truncate+insert below would resurrect a mid-load delete; the next
      // bus event or reconnect converges (same trade as the old bridge).
      void (async () => {
        try {
          let cursor: string | undefined;
          for (let page = 0; page < 5; page += 1) {
            const result = await getOcClient().listSessions({
              limit: 100,
              order: "desc",
              ...(cursor !== undefined ? { cursor } : {}),
            });
            listState = applySessionListPage(
              listState,
              { sessions: result.sessions, nextCursor: result.nextCursor },
              { replace: page === 0 },
            );
            if (result.nextCursor === undefined) break;
            cursor = result.nextCursor;
          }
          // One-shot busy seeding for turns already running when the app
          // launched (same as the official GUI's bootstrap) — a resume
          // read, not polling; the bus owns every transition after this.
          try {
            const active = await getOcClient().activeSessionIDs();
            if (!disposed) {
              for (const id of active) statusById.set(id, "busy");
            }
          } catch (err) {
            console.warn("[sessions] active seed failed:", err);
          }
          if (disposed) return;
          begin();
          truncate();
          for (const item of listState.items) {
            write({
              type: "insert",
              value: toRow(item, statusById.get(item.id) ?? "idle"),
            });
          }
          commit();
        } catch (err) {
          console.warn("[sessions] initial list failed:", err);
        } finally {
          if (!hasMarkedReady && !disposed) {
            markReady();
            hasMarkedReady = true;
          }
        }
      })();

      return () => {
        disposed = true;
        unregisterSink();
        unsubscribeBus();
      };
    },
  },
});
