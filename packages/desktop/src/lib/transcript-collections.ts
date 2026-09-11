import {
  type Collection,
  createCollection,
  createOptimisticAction,
} from "@tanstack/react-db";
import {
  applyOcEvent,
  createInitialTranscriptState,
  type OcRow,
  type OcTranscriptState,
} from "@thinkite/oc-client";
import { getOcClient, sharedOcBus } from "./oc";
import { publishSessionStatus } from "./session-status";

// Per-session live transcript collections — same Map-of-collections
// pattern as before (TanStack/db#652): one collection per opencode
// `ses_*` id; the sync handler owns the session stream + bus routing, so
// any number of consumers share one stream and back-nav within gcTime
// never re-opens it.
//
// Data now comes from `@thinkite/oc-client` instead of the daemon's
// `/rpc` transcript path: initial `/api/session/:id/history` page(s),
// then one durable session stream (`after=` resume on reconnect) plus the
// shared global bus (live-only deltas, `session.status`), both folded
// through the pure reducer. The reducer owns merge truth (seq dedupe,
// delta→ended reconcile); this module only mirrors its rows into the
// collection incrementally — new keys insert at the tail, changed rows
// update in place (row objects keep identity when untouched, so a `!==`
// check is the whole diff).

export type OrderedOcRow = OcRow & { _order: number };

const collections = new Map<string, Collection<OrderedOcRow, string>>();

const rowKey = (row: OcRow): string => row.id;

export function getTranscriptCollection(
  sessionId: string,
): Collection<OrderedOcRow, string> {
  const cached = collections.get(sessionId);
  if (cached !== undefined) return cached;

  const collection = createCollection<OrderedOcRow, string>({
    id: `transcript-${sessionId}`,
    getKey: rowKey,
    compare: (a, b) => a._order - b._order,
    // gcTime: react-db default (5 min). A switched-away session's data is
    // small relative to the real renderer costs (Pierre wasm, xterm), and
    // the longer window makes back-nav re-opens rarer.
    sync: {
      sync: ({
        begin,
        write,
        commit,
        markReady,
        truncate,
        collection: coll,
      }) => {
        // markReady() exactly once per sync-handler lifetime; reconnect
        // re-attaches without re-gating isLoading.
        let hasMarkedReady = false;
        let disposed = false;
        let state: OcTranscriptState = createInitialTranscriptState();
        // Last rendered row object per key — identity diff.
        const rendered = new Map<string, OcRow>();

        const mirror = () => {
          begin();
          for (const row of state.rows) {
            const key = rowKey(row);
            const prev = rendered.get(key);
            if (prev === row) continue;
            if (prev === undefined) {
              const existing = coll.get(key);
              write({
                type: "insert",
                value: { ...row, _order: existing?._order ?? coll.size },
              });
            } else {
              const current = coll.get(key);
              write({
                type: "update",
                value: {
                  ...row,
                  _order: current?._order ?? coll.size,
                },
              });
            }
            rendered.set(key, row);
          }
          commit();
        };

        const ingest = (event: { type: string; data?: unknown }) => {
          const next = applyOcEvent(state, event);
          if (next === state) return;
          const statusChanged = next.status !== state.status;
          state = next;
          mirror();
          // Durable reading of busy/idle → sessions row (session-status.ts).
          if (statusChanged) publishSessionStatus(sessionId, next.status);
        };

        const ready = () => {
          if (!hasMarkedReady && !disposed) {
            markReady();
            hasMarkedReady = true;
          }
        };

        // Cold path — full history, then live. Truncate inside the sync
        // transaction so observers never see a flash of empty.
        const open = async (signal: AbortSignal) => {
          try {
            let after = 0;
            for (let page = 0; page < 20; page += 1) {
              const result = await getOcClient().history(sessionId, after, 100);
              if (signal.aborted || disposed) return;
              for (const event of result.events) {
                const next = applyOcEvent(state, event);
                if (next !== state) state = next;
                const seq = (event.durable as { seq?: number } | undefined)
                  ?.seq;
                if (typeof seq === "number" && seq > after) after = seq;
              }
              if (!result.hasMore) break;
            }
            if (signal.aborted || disposed) return;
            begin();
            truncate();
            rendered.clear();
            for (const row of state.rows) {
              write({
                type: "insert",
                value: { ...row, _order: rendered.size },
              });
              rendered.set(rowKey(row), row);
            }
            commit();
          } catch (err) {
            console.warn(`[transcript] history failed for ${sessionId}:`, err);
          } finally {
            ready();
          }
          if (signal.aborted || disposed) return;

          // Follow: durable stream with `after=` resume. The SDK stream
          // retries internally on blips; a return here means the server
          // closed it (restart) — re-issue with backoff until disposed.
          let backoff = 1000;
          while (!signal.aborted && !disposed) {
            try {
              for await (const event of getOcClient().openSessionStream(
                sessionId,
                state.lastSeq,
                { signal },
              )) {
                backoff = 1000;
                ingest(event);
              }
            } catch (err) {
              if (signal.aborted || disposed) return;
              console.warn(
                `[transcript] stream ended for ${sessionId}, retrying:`,
                err,
              );
            }
            if (signal.aborted || disposed) return;
            await new Promise((r) => setTimeout(r, backoff));
            backoff = Math.min(backoff * 2, 10_000);
          }
        };

        const abort = new AbortController();
        void open(abort.signal);

        // Shared bus, routed to this session by `sessionID`. Carries the
        // live-only deltas plus `session.status`; durable duplicates of
        // stream events dedupe by seq in the reducer.
        const unsubscribeBus = sharedOcBus.subscribe((event) => {
          if (disposed) return;
          const data = event.data as { sessionID?: unknown } | undefined;
          if (data?.sessionID !== sessionId) return;
          ingest(event);
        });

        // Runs when gcTime expires (no subscribers for ≥5 min).
        return () => {
          disposed = true;
          abort.abort();
          unsubscribeBus();
        };
      },
    },
  });

  // Auto-evict when the collection finishes its own cleanup lifecycle —
  // a dead entry left in the cache would hand consumers a cleaned-up
  // collection that throws on writes.
  collection.on("status:change", ({ status }) => {
    if (status === "cleaned-up") {
      collections.delete(sessionId);
    }
  });

  collections.set(sessionId, collection);
  return collection;
}

/** Drop a cached collection (after delete) so the next open re-syncs. */
export function evictTranscriptCollection(sessionId: string): void {
  collections.delete(sessionId);
}

interface SendMessageVars {
  sessionId: string;
  /** Client-minted input id — sent as the prompt `id` so the durable
   *  `prompt.admitted`/`prompted` events echo it as `messageID` and the
   *  synced user row lands on the optimistic bubble by key, no flicker. */
  userMessageUuid: string;
  text: string;
}

/**
 * Optimistic send: `onMutate` paints the user bubble synchronously;
 * `mutationFn` admits the prompt with the same id. The durable admitted
 * event fans out on the session stream / bus and upserts onto the same
 * key, so the overlay lands seamlessly. On failure the action rolls the
 * insert back automatically.
 */
export const sendUserMessage = createOptimisticAction<SendMessageVars>({
  onMutate: ({ sessionId, userMessageUuid, text }) => {
    const coll = getTranscriptCollection(sessionId);
    coll.insert({
      kind: "user",
      id: userMessageUuid,
      text,
      _order: coll.size,
    });
  },
  mutationFn: async ({ sessionId, userMessageUuid, text }) => {
    await getOcClient().prompt(sessionId, text, { id: userMessageUuid });
  },
});
