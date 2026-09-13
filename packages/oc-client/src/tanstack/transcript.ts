import {
  type Collection,
  createCollection,
  createOptimisticAction,
  type Transaction,
} from "@tanstack/db";
import type { OcClient, SessionMessageInfo } from "../client.ts";
import {
  durableSeq,
  type OcEvent,
  sessionIDOf,
  subscribeEvents,
} from "../events.ts";
import {
  applyTranscriptEvent,
  mergeProjection,
  STREAMING_EVENT_TYPES,
  type TranscriptRows,
  TURN_END_EVENT_TYPES,
} from "../transcript-reducer.ts";

// Per-session transcript collections — one per opencode `ses_*` id, rows
// are opencode's own `SessionMessageInfo` projection. The sync handler
// owns three things:
//
//   1. Hydration and paging from `message.list` (newest page first; older
//      pages prepended on demand — see `paging`). A local service keeps
//      no durable event log, so the projection is the only history.
//   2. The live turn: streaming events folded by the pure reducer.
//   3. Settling: the projection tail is re-read when a turn ends, after
//      a reconnect (`server.connected`), and — coalesced — after any
//      durable session event the reducer does not fold (compaction,
//      revert, agent/model switches, …), so the server's projection
//      always wins over what the reducer built.
//
// Consumers read the collection with a live query ordered by
// `time.created` (then `id`) and the `paging` collection for load-more
// state; nothing here is React.

export interface SendMessageVars {
  sessionId: string;
  /** Client-minted `msg_*` id — sent as the prompt `id` so the durable
   *  `session.inbox.enqueued` event and the projection row carry it and
   *  the optimistic user row lands on the synced one by key. */
  userMessageUuid: string;
  text: string;
}

export type TranscriptPagingRow = {
  /** Session id. */
  id: string;
  /** Older messages exist beyond the loaded window. */
  hasOlder: boolean;
  /** An older page is being read. */
  loading: boolean;
  /** First projection read finished (rows may still be empty). */
  hydrated: boolean;
};

export interface TranscriptCollections {
  get(sessionId: string): Collection<SessionMessageInfo, string>;
  /** Load-more state per session (keyed by session id). */
  readonly paging: Collection<TranscriptPagingRow, string>;
  /** Prepend the next older page; resolves when it is in the collection. */
  loadOlder(sessionId: string): Promise<void>;
  /** Drop a cached collection (after delete) so the next open re-reads. */
  evict(sessionId: string): void;
  /** Tear down every cached collection and its bus subscription. */
  disposeAll(): void;
  sendUserMessage(variables: SendMessageVars): Transaction;
}

export interface TranscriptCollectionsOptions {
  client: OcClient;
  /** Messages per projection read; opencode's GUI uses 20. */
  pageSize?: number;
  /** Trailing window that coalesces settle reads after event bursts. */
  settleMs?: number;
}

export function createTranscriptCollections({
  client,
  pageSize = 20,
  settleMs = 200,
}: TranscriptCollectionsOptions): TranscriptCollections {
  const collections = new Map<string, Collection<SessionMessageInfo, string>>();
  const controls = new Map<string, { loadOlder: () => Promise<void> }>();

  // Load-more state lives in its own tiny collection so screens can
  // subscribe to it with a live query. Its sync handle is captured once
  // (`startSync: true` runs the handler synchronously at creation).
  let pagingSync: {
    begin: () => void;
    write: (message: {
      type: "insert" | "update";
      value: TranscriptPagingRow;
    }) => void;
    commit: () => void;
  } | null = null;
  const pagingRows = new Map<string, TranscriptPagingRow>();
  const paging = createCollection<TranscriptPagingRow, string>({
    id: "transcript-paging",
    getKey: (r) => r.id,
    startSync: true,
    sync: {
      sync: ({ begin, write, commit, markReady }) => {
        pagingSync = { begin, write, commit };
        markReady();
        return () => {
          pagingSync = null;
          pagingRows.clear();
        };
      },
    },
  });
  const setPaging = (row: TranscriptPagingRow) => {
    const existing = pagingRows.get(row.id);
    if (
      existing !== undefined &&
      existing.hasOlder === row.hasOlder &&
      existing.loading === row.loading &&
      existing.hydrated === row.hydrated
    )
      return;
    if (pagingSync === null) return;
    pagingSync.begin();
    pagingSync.write({
      type: existing === undefined ? "insert" : "update",
      value: row,
    });
    pagingSync.commit();
    pagingRows.set(row.id, row);
  };

  function get(sessionId: string): Collection<SessionMessageInfo, string> {
    const cached = collections.get(sessionId);
    if (cached !== undefined) return cached;

    const collection = createCollection<SessionMessageInfo, string>({
      id: `transcript-${sessionId}`,
      getKey: (row) => row.id,
      sync: {
        sync: ({ begin, write, commit, markReady }) => {
          let hasMarkedReady = false;
          let disposed = false;
          const abort = new AbortController();
          let rows: TranscriptRows = [];
          let cursor: string | undefined;
          let hydrated = false;
          let loadingOlder = false;
          const rendered = new Map<string, SessionMessageInfo>();

          const pagingRow = () =>
            setPaging({
              id: sessionId,
              hasOlder: cursor !== undefined,
              loading: loadingOlder,
              hydrated,
            });

          const ready = () => {
            if (hasMarkedReady || disposed) return;
            markReady();
            hasMarkedReady = true;
          };

          // Mirror the reducer's rows into the collection: identity diff,
          // inserts for new keys, updates for changed objects, deletes for
          // keys that left.
          const mirror = () => {
            begin();
            const seen = new Set<string>();
            for (const row of rows) {
              seen.add(row.id);
              const prev = rendered.get(row.id);
              if (prev === row) continue;
              write({
                type: prev === undefined ? "insert" : "update",
                value: row,
              });
              rendered.set(row.id, row);
            }
            for (const key of [...rendered.keys()]) {
              if (seen.has(key)) continue;
              rendered.delete(key);
              write({ type: "delete", key });
            }
            commit();
          };

          const apply = (next: TranscriptRows) => {
            if (next === rows) return;
            rows = next;
            mirror();
          };

          // Newest page. First call hydrates; later calls (turn end,
          // reconnect, settle) merge the tail by id.
          let reading: Promise<void> | null = null;
          const readTail = () => {
            if (reading !== null) return reading;
            reading = (async () => {
              try {
                const page = await client.listMessages(sessionId, {
                  limit: pageSize,
                });
                if (disposed) return;
                const newest = page.messages.slice().reverse();
                if (!hydrated) {
                  hydrated = true;
                  cursor = page.nextCursor;
                }
                apply(mergeProjection(rows, newest));
              } catch (err) {
                console.warn(`[transcript] read failed for ${sessionId}:`, err);
              } finally {
                reading = null;
                ready();
                pagingRow();
              }
            })();
            return reading;
          };

          const loadOlder = async () => {
            if (cursor === undefined || loadingOlder || disposed) return;
            loadingOlder = true;
            pagingRow();
            try {
              const page = await client.listMessages(sessionId, {
                limit: pageSize,
                cursor,
              });
              if (disposed) return;
              cursor = page.nextCursor;
              const older = page.messages.slice().reverse();
              const present = new Set(rows.map((r) => r.id));
              const fresh = older.filter((m) => !present.has(m.id));
              if (fresh.length > 0) apply([...fresh, ...rows]);
            } catch (err) {
              console.warn(
                `[transcript] older page failed for ${sessionId}:`,
                err,
              );
            } finally {
              loadingOlder = false;
              pagingRow();
            }
          };
          controls.set(sessionId, { loadOlder });

          let settleTimer: ReturnType<typeof setTimeout> | undefined;
          const settle = () => {
            if (settleTimer !== undefined) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => {
              settleTimer = undefined;
              void readTail();
            }, settleMs);
          };

          let skipNextConnected = true;
          const handle = (event: OcEvent) => {
            if (event.type === "server.connected") {
              if (skipNextConnected) {
                skipNextConnected = false;
                return;
              }
              if (hydrated) void readTail();
              return;
            }
            if (sessionIDOf(event) !== sessionId) return;
            if (STREAMING_EVENT_TYPES.has(event.type)) {
              apply(applyTranscriptEvent(rows, event));
              return;
            }
            if (TURN_END_EVENT_TYPES.has(event.type)) {
              if (settleTimer !== undefined) clearTimeout(settleTimer);
              settleTimer = undefined;
              void readTail();
              return;
            }
            if (durableSeq(event) !== undefined) settle();
          };

          void readTail();
          void subscribeEvents(client, handle, {
            signal: abort.signal,
            onError: (err) =>
              console.warn(`[transcript] bus for ${sessionId}:`, err),
          });
          pagingRow();

          return () => {
            disposed = true;
            abort.abort();
            if (settleTimer !== undefined) clearTimeout(settleTimer);
            controls.delete(sessionId);
          };
        },
      },
    });

    collection.on("status:change", ({ status }) => {
      if (status === "cleaned-up") {
        collections.delete(sessionId);
        controls.delete(sessionId);
      }
    });

    collections.set(sessionId, collection);
    return collection;
  }

  function evict(sessionId: string): void {
    collections.delete(sessionId);
    controls.delete(sessionId);
  }

  function disposeAll(): void {
    for (const collection of collections.values()) {
      void collection.cleanup().catch((err) => {
        console.warn("[transcript] cleanup failed:", err);
      });
    }
    collections.clear();
    controls.clear();
  }

  async function loadOlder(sessionId: string): Promise<void> {
    await controls.get(sessionId)?.loadOlder();
  }

  const sendUserMessage = createOptimisticAction<SendMessageVars>({
    onMutate: ({ sessionId, userMessageUuid, text }) => {
      get(sessionId).insert({
        id: userMessageUuid,
        type: "user",
        text,
        time: { created: Date.now() },
      });
    },
    mutationFn: async ({ sessionId, userMessageUuid, text }) => {
      await client.prompt(sessionId, text, { id: userMessageUuid });
    },
  });

  return { get, paging, loadOlder, evict, disposeAll, sendUserMessage };
}
