import type { ImageAttachment } from "@sidecodeapp/protocol";
import { createOptimisticAction } from "@tanstack/db";
import { queryCollectionOptions } from "@tanstack/query-db-collection";
import { createCollection } from "@tanstack/react-db";
import { daemonClient } from "@/lib/daemon-client";
import { queryClient } from "@/lib/query-client";
import type { SessionInfo } from "@/types/session";

/**
 * The app's single sessions collection, backed by the `listSessions` RPC.
 *
 * A module-level const (not a per-client factory): the `daemonClient` it
 * talks to is itself a module singleton, and there's only ever one
 * sessions collection — so it mirrors the `queryClient` singleton and can
 * be imported directly by any consumer (`useLiveQuery` reads, the
 * mutations below) without threading the client through React context.
 *
 * Why a TanStack DB query collection instead of a plain React Query
 * `useQuery(["sessions"])`: reads come from one place (`useLiveQuery` in
 * `use-sessions.ts`) and writes are direct + optimistic against the same
 * synced store — no `setQueryData` / `invalidateQueries` choreography.
 *
 * Mutations use the idiomatic optimistic APIs. The optimistic state is
 * dropped when persistence resolves, so each one syncs the change back
 * via `utils.refetch()` (or the query collection's auto-refetch) before
 * completing — see the TanStack DB mutations guide:
 *
 *   - model pick (`use-set-session-selection.ts`): `collection.update`
 *     applies the optimistic chip change; the `onUpdate` handler below
 *     fires `setSessionSelection` and query-db auto-refetches to confirm.
 *     Relies on the daemon echoing `model` back in listSessions
 *     (toSessionInfoFromSidecode); without that the refetch would revert
 *     the chip. A throw rolls the optimistic update back automatically.
 *
 *   - new session (`createSession` below): a `createOptimisticAction`
 *     whose `onMutate` inserts a client-built row (instant sidebar entry
 *     with a title) and whose `mutationFn` runs the first `sendPrompt`
 *     (the create on the daemon) then `utils.refetch()`. An action, not an
 *     `onInsert` handler, because creation needs the prompt payload the
 *     SessionInfo row doesn't carry.
 *
 * The low-level `utils.write*` direct-write primitives are intentionally
 * NOT used for these user mutations; they're reserved for folding in
 * server-pushed deltas without a refetch (the future Slice I fs.watch
 * tail), where there's no optimistic transaction to reconcile.
 *
 * `startSync: true` keeps the store warm from app start. The first
 * `listSessions` just pends on the facade's readyPromise until the
 * Provider attaches a transport (and stays pending while unpaired) — no
 * error, the facade blocks RPCs until ready.
 */
export const sessionsCollection = createCollection(
  queryCollectionOptions({
    id: "sessions",
    queryClient,
    queryKey: ["sessions"],
    queryFn: async (): Promise<SessionInfo[]> =>
      (await daemonClient.listSessions()) as SessionInfo[],
    getKey: (s: SessionInfo) => s.cliSessionId,
    startSync: true,
    onUpdate: async ({ transaction }) => {
      for (const m of transaction.mutations) {
        await daemonClient.setSessionSelection({
          sessionId: m.modified.cliSessionId,
          model: m.modified.model,
        });
      }
    },
  }),
);

const TITLE_MAX_LEN = 200;

/**
 * Client-side mirror of the daemon's `deriveTitleFromFirstPrompt`
 * (sidecode-sessions.ts) — used to label the optimistic row at create
 * time. The daemon derives the same title with the same algorithm and
 * `utils.refetch()` folds it in, so any drift self-heals on reconcile;
 * keeping them identical just avoids a visible title flicker.
 */
export function deriveSessionTitle(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TITLE_MAX_LEN) return oneLine;
  return `${oneLine.slice(0, TITLE_MAX_LEN - 1).trimEnd()}…`;
}

interface CreateSessionVars {
  cliSessionId: string;
  text: string;
  cwd: string;
  images?: ImageAttachment[];
  model?: string;
}

/**
 * Optimistic "create a new session" action.
 *
 * `onMutate` inserts a client-built row so the sidebar shows the new
 * session immediately (with a title derived the way the daemon does),
 * instead of after the 30s staleTime. `mutationFn` fires the first
 * `sendPrompt` — which IS the create on the daemon — then
 * `utils.refetch()` folds the canonical row in by cliSessionId.
 *
 * An action rather than `collection.insert` + an `onInsert` handler
 * because `onInsert` only receives the SessionInfo row, but creation
 * needs the prompt text/images/cwd/model the row doesn't carry; the
 * action's variables hold that full payload.
 *
 * The optimistic state is dropped when `mutationFn` returns, so the
 * refetch (after sendPrompt's response — the daemon writes metadata
 * before replying) must land the canonical row first. On reject the
 * optimistic insert rolls back automatically; callers can observe failure
 * via the returned transaction's `isPersisted.promise`.
 */
export const createSession = createOptimisticAction<CreateSessionVars>({
  onMutate: (vars) => {
    sessionsCollection.insert({
      sessionId: `local_${vars.cliSessionId}`,
      cliSessionId: vars.cliSessionId,
      origin: "sidecode-created",
      title: deriveSessionTitle(vars.text),
      cwd: vars.cwd,
      originCwd: vars.cwd,
      lastActivityAt: Date.now(),
      isArchived: false,
    });
  },
  mutationFn: async (vars) => {
    await daemonClient.sendPrompt({
      sessionId: vars.cliSessionId,
      text: vars.text,
      cwd: vars.cwd,
      images: vars.images,
      model: vars.model,
    });
    await sessionsCollection.utils.refetch();
  },
});
