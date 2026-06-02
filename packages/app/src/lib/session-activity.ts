import type { TurnUsage } from "@sidecodeapp/protocol";
import {
  createCollection,
  eq,
  localOnlyCollectionOptions,
  useLiveQuery,
} from "@tanstack/react-db";

/**
 * Per-session live turn state (isRunning / lastError / latestUsage) — the
 * "is this session working right now" data that the detail screen shows
 * and that the drawer will eventually show per row.
 *
 * This is NOT session metadata (that's the #17 subscribeSessions-backed
 * `sessionStateCollection`, server-authoritative). It's ephemeral client-
 * observed state, so it lives in its OWN collection: a push to the
 * sessions list must never clobber it, and a list (drawer) can join it.
 *
 * A `localOnly` collection — pure in-memory, no external sync source —
 * because today the data is fed in from the *transcript* subscription
 * (transcript-collection-factory.ts routes turn_* deltas here via
 * patchSessionActivity). When the daemon grows a session-level activity
 * broadcast (W3), this should become a custom-sync collection that owns
 * that subscription; consumers (useSessionActivity / a drawer join) read
 * via useLiveQuery either way, so that swap won't touch them.
 *
 * Interim limitation: rows are only fresh while the feeding transcript
 * subscription is alive. Leaving a session gc's its transcript (~60s),
 * after which its row is cleared (clearSessionActivity) rather than left
 * frozen — so the drawer would simply show "no activity," never a stale
 * "running". Full per-session liveness waits on the daemon broadcast.
 */
export interface SessionActivity {
  cliSessionId: string;
  isRunning: boolean;
  lastError: string | null;
  latestUsage: TurnUsage | null;
}

const DEFAULTS: Omit<SessionActivity, "cliSessionId"> = {
  isRunning: false,
  lastError: null,
  latestUsage: null,
};

export const sessionActivityCollection = createCollection(
  localOnlyCollectionOptions({
    id: "session-activity",
    getKey: (a: SessionActivity) => a.cliSessionId,
  }),
);

/**
 * Upsert a session's activity. `collection.update` throws on a missing key
 * and `insert` throws on an existing one, and localOnly has no upsert util
 * — so branch on presence. Direct (auto-commit) mutations loopback-sync
 * immediately; no handler / acceptMutations needed.
 */
export function patchSessionActivity(
  cliSessionId: string,
  patch: Partial<Omit<SessionActivity, "cliSessionId">>,
): void {
  if (sessionActivityCollection.get(cliSessionId) === undefined) {
    sessionActivityCollection.insert({
      cliSessionId,
      ...DEFAULTS,
      ...patch,
    });
  } else {
    sessionActivityCollection.update(cliSessionId, (draft) => {
      Object.assign(draft, patch);
    });
  }
}

/** Drop a session's activity row (called when its transcript is gc'd). */
export function clearSessionActivity(cliSessionId: string): void {
  if (sessionActivityCollection.get(cliSessionId) !== undefined) {
    sessionActivityCollection.delete(cliSessionId);
  }
}

// Stable reference for the "no row yet" case so consumers don't re-render
// on identity churn. Consumers only read isRunning / lastError /
// latestUsage; the empty cliSessionId is never observed.
const EMPTY: SessionActivity = { cliSessionId: "", ...DEFAULTS };

/**
 * Reactive read of one session's live turn state. Returns DEFAULTS when no
 * row exists yet (session never started a turn this session, or its row
 * was cleared) OR when `cliSessionId` is null (the new-session screen has
 * no session — the query is disabled and DEFAULTS stands in).
 */
export function useSessionActivity(
  cliSessionId: string | null,
): SessionActivity {
  const { data } = useLiveQuery(
    (q) =>
      cliSessionId
        ? q
            .from({ a: sessionActivityCollection })
            .where(({ a }) => eq(a.cliSessionId, cliSessionId))
            .findOne()
        : null,
    [cliSessionId],
  );
  return data ?? EMPTY;
}
