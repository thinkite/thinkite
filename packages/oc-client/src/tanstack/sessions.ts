import { type Collection, createCollection } from "@tanstack/db";
import type { OcClient } from "../client.ts";
import { type OcEvent, sessionIDOf, subscribeEvents } from "../events.ts";
import {
  applySessionEvent,
  type SessionRow,
  sessionRowFromCreated,
  sessionRowFromInfo,
} from "../session-reducer.ts";

export type { SessionActivity, SessionRow } from "../session-reducer.ts";

/**
 * The session list as a TanStack DB collection, keyed by the opencode
 * `ses_*` id.
 *
 * Ground truth is `session.list` (paged, newest first) plus one
 * `session.active()` read for turns already running; both are re-read on
 * every `server.connected`, i.e. at start and after each reconnect —
 * the same resync the official GUI does. Between reads the bus patches
 * rows: `session.created/deleted/renamed/moved/model.selected`, and
 * `session.execution.*` for busy/idle. No polling anywhere.
 */
export interface SessionsCollectionOptions {
  client: OcClient;
  /**
   * Start the list read + bus subscription at creation. Defaults to `true`
   * (desktop); the phone creates the collection before its daemon
   * connection is online and starts sync from its connection gate.
   */
  startSync?: boolean;
  /** Pages of 100 read on each resync. */
  maxPages?: number;
}

export function createSessionsCollection({
  client,
  startSync = true,
  maxPages = 5,
}: SessionsCollectionOptions): Collection<SessionRow, string> {
  return createCollection<SessionRow, string>({
    id: "session-states",
    getKey: (r) => r.id,
    startSync,
    sync: {
      sync: ({ begin, write, commit, markReady, truncate }) => {
        let hasMarkedReady = false;
        let disposed = false;
        const abort = new AbortController();
        // Activity survives a resync: the list payload carries no busy
        // flag, `session.active()` and the bus own it.
        const activity = new Map<string, SessionRow["activity"]>();
        // Rows this handler has written (the collection's `get` also sees
        // optimistic overlays, which must not steer insert-vs-update).
        const synced = new Map<string, SessionRow>();

        const ready = () => {
          if (hasMarkedReady || disposed) return;
          markReady();
          hasMarkedReady = true;
        };

        const upsert = (row: SessionRow) => {
          write({ type: synced.has(row.id) ? "update" : "insert", value: row });
          synced.set(row.id, row);
        };

        let resyncing: Promise<void> | null = null;
        const resync = () => {
          if (resyncing !== null) return resyncing;
          resyncing = (async () => {
            try {
              const rows: SessionRow[] = [];
              let cursor: string | undefined;
              for (let page = 0; page < maxPages; page += 1) {
                const result = await client.listSessions({
                  limit: 100,
                  cursor,
                });
                if (disposed) return;
                for (const info of result.sessions) {
                  rows.push(
                    sessionRowFromInfo(info, activity.get(info.id) ?? "idle"),
                  );
                }
                if (result.nextCursor === undefined) break;
                cursor = result.nextCursor;
              }
              try {
                const active = await client.activeSessionIDs();
                if (disposed) return;
                for (const row of rows) {
                  row.activity = active.has(row.id) ? "running" : "idle";
                  activity.set(row.id, row.activity);
                }
              } catch (err) {
                console.warn("[sessions] active read failed:", err);
              }
              begin();
              truncate();
              synced.clear();
              for (const row of rows) {
                write({ type: "insert", value: row });
                synced.set(row.id, row);
              }
              commit();
            } catch (err) {
              console.warn("[sessions] list read failed:", err);
            } finally {
              resyncing = null;
              ready();
            }
          })();
          return resyncing;
        };

        // The first `server.connected` belongs to the connection the
        // initial read below already covers.
        let skipNextConnected = true;
        const handle = (event: OcEvent) => {
          if (event.type === "server.connected") {
            if (skipNextConnected) {
              skipNextConnected = false;
              return;
            }
            void resync();
            return;
          }
          if (event.type === "session.created") {
            const row = sessionRowFromCreated(event);
            if (synced.has(row.id)) return;
            begin();
            upsert(row);
            commit();
            return;
          }
          const id = sessionIDOf(event);
          if (id === undefined) return;
          if (event.type === "session.deleted") {
            activity.delete(id);
            if (!synced.has(id)) return;
            synced.delete(id);
            begin();
            write({ type: "delete", key: id });
            commit();
            return;
          }
          const current = synced.get(id);
          if (current === undefined) return;
          const next = applySessionEvent(current, event);
          if (next === current) return;
          activity.set(id, next.activity);
          begin();
          upsert(next);
          commit();
        };

        void resync();
        void subscribeEvents(client, handle, {
          signal: abort.signal,
          onError: (err) => console.warn("[sessions] bus:", err),
        });

        return () => {
          disposed = true;
          abort.abort();
        };
      },
    },
  });
}
