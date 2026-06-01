import type { ImageAttachment, SessionState } from "@sidecodeapp/protocol";
import { createOptimisticAction } from "@tanstack/db";
import { createCollection } from "@tanstack/react-db";
import { daemonClient } from "@/lib/daemon-client";

/**
 * #17 — iOS row shape for the session-states collection. Wraps the
 * daemon's `SessionState` payload (live + static fields) with the
 * client-side `cliSessionId` key used by every list row + URL.
 *
 * Drop-in for the old `SessionInfo`. Differences:
 *   - `sessionId: "local_<id>"` is GONE — collection key is now
 *     `cliSessionId` directly. The `local_` prefix was Desktop-mirror
 *     bookkeeping; V0 only carries sidecode-owned sessions.
 *   - `origin` is GONE — V0 cuts Desktop view-only sessions, so every
 *     row is sidecode-owned.
 *   - `originCwd` is GONE — flat sort by `lastActivityAt` desc, no
 *     project grouping per [[project_v0_session_list_design]].
 *   - `modelLabel` is GONE — computed client-side from `useModels()`
 *     in the row component (lookup is cached forever, pure sync).
 *
 * `activity` / `createdAt` / `permissionMode` are NEW fields surfaced
 * by the #17 stream.
 */
export type SessionRow = SessionState & {
  cliSessionId: string;
};

/**
 * The app's single session-state collection, backed by the daemon's
 * `subscribeSessions` push stream.
 *
 * Sync handler subscribes once per attach. Daemon delivers a fresh
 * `initial` snapshot on every (re)connect — handler truncates + bulk
 * inserts. Live `session_state_changed` / `session_state_removed`
 * push envelopes upsert / delete row-by-row.
 *
 * Last-write-wins semantics; no cursor / no replay gap.
 * `daemonClient.subscribeSessions` survives transport reconnects
 * transparently (re-issues the RPC + re-delivers onInitial on attach).
 *
 * `startSync: true` keeps the collection warm from app start. The first
 * subscribe blocks on the daemon transport's readyPromise internally —
 * no `enabled` gate needed.
 */
export const sessionStateCollection = createCollection<SessionRow, string>({
  id: "session-states",
  getKey: (r) => r.cliSessionId,
  startSync: true,
  sync: {
    sync: ({ begin, write, commit, markReady, truncate, collection: coll }) => {
      let hasMarkedReady = false;

      const handle = daemonClient.subscribeSessions({
        onInitial: (entries) => {
          // Each onInitial fire is ground truth (initial attach + every
          // reconnect). Truncate first so a row removed from the server
          // side between connects doesn't linger; then bulk insert.
          begin();
          truncate();
          for (const { sessionId, state } of entries) {
            write({
              type: "insert",
              value: { cliSessionId: sessionId, ...state },
            });
          }
          commit();
          if (!hasMarkedReady) {
            markReady();
            hasMarkedReady = true;
          }
        },
        onChange: (sessionId, state) => {
          // Upsert: branch on presence to pick the right write op.
          // TanStack DB's `insert` / `update` are mutually exclusive
          // (insert throws on existing, update throws on missing).
          const existing = coll.get(sessionId);
          begin();
          if (existing === undefined) {
            write({
              type: "insert",
              value: { cliSessionId: sessionId, ...state },
            });
          } else {
            write({
              type: "update",
              value: { cliSessionId: sessionId, ...state },
            });
          }
          commit();
        },
        onRemove: (sessionId) => {
          // V0 daemon never fires this (no user-driven delete), but
          // wire it for V0.5+ forward compat.
          if (coll.get(sessionId) === undefined) return;
          begin();
          write({ type: "delete", key: sessionId });
          commit();
        },
      });
      return () => handle.unsubscribe();
    },
  },
});

const TITLE_MAX_LEN = 200;

/**
 * Client-side mirror of the daemon's `deriveTitleFromFirstPrompt`
 * (sidecode-sessions.ts). Used to label the optimistic row at create
 * time; the daemon derives the same title and the #17 push folds it in,
 * so any drift self-heals on reconcile.
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
 * session immediately. `mutationFn` fires the first `sendPrompt` (which
 * IS the create on the daemon) — the daemon then emits a
 * `session_state_changed` envelope which the sync handler folds in,
 * replacing the optimistic row with the canonical state.
 *
 * No `utils.refetch()` needed — the push channel IS the refetch. The
 * optimistic state is dropped when mutationFn resolves; the canonical
 * row from the push is already in the collection by then.
 *
 * Optimistic seed values match the daemon's own initial state so the
 * visible transition on reconcile is minimal: `activity: "running"`
 * (the prompt just fired), `lastActivityAt: now`,
 * `permissionMode: "bypassPermissions"` (V0 owned-session default —
 * see project_no_plan_mode_v0 / sidecode-sessions.ts default).
 */
export const createSession = createOptimisticAction<CreateSessionVars>({
  onMutate: (vars) => {
    const now = Date.now();
    sessionStateCollection.insert({
      cliSessionId: vars.cliSessionId,
      activity: "running",
      model: vars.model ?? null,
      lastActivityAt: now,
      title: deriveSessionTitle(vars.text),
      cwd: vars.cwd,
      createdAt: now,
      isArchived: false,
      permissionMode: "bypassPermissions",
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
    // No refetch — daemon's setActivity("running") on this prompt fires
    // a session_state_changed envelope which the sync handler folds in
    // by cliSessionId. The optimistic row drops as the canonical lands.
  },
});

/**
 * Pick a new model for an existing session. Optimistic + push-reconcile:
 *
 *   1. `onMutate` updates the row's `model` field in the collection so
 *      the chip and any list row update instantly.
 *   2. `mutationFn` fires `setSessionSelection` — the daemon applies via
 *      `applyFlagSettings`, mirrors to `runtime.setModel` (#17 fan-out),
 *      and persists to disk. The fan-out includes ALL connected peers
 *      (including this one), so the push delivers the canonical state
 *      back through the sync handler's `onChange` upsert.
 *
 * On rejection the optimistic update rolls back automatically — the
 * picker chip reverts.
 */
export const updateSessionModel = createOptimisticAction<{
  cliSessionId: string;
  model: string | undefined;
}>({
  onMutate: ({ cliSessionId, model }) => {
    if (sessionStateCollection.get(cliSessionId) === undefined) return;
    sessionStateCollection.update(cliSessionId, (draft) => {
      // Protocol normalizes "no selection" to null. iOS picker passes
      // `undefined` for "reset to SDK default" — map to null so the
      // optimistic draft has the same shape the push will deliver.
      draft.model = model ?? null;
    });
  },
  mutationFn: async ({ cliSessionId, model }) => {
    await daemonClient.setSessionSelection({
      sessionId: cliSessionId,
      model,
    });
  },
});
