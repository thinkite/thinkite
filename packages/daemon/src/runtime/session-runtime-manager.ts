/**
 * Holds all SessionRuntime instances for a daemon process. Lazy-creates
 * runtimes on `getOrCreate`; V0 GC policy: each runtime can dispose its
 * heavy SDK subprocess (`disposeQuery`, M3.7) on idle but the runtime
 * itself isn't auto-evicted until daemon shutdown.
 *
 * #17 adds a daemon-wide SessionState fan-out:
 *
 *   - every runtime created here gets its `onStateChanged` callback wired
 *     to `notifyStateChanged` so the manager sees every activity / model
 *     edge across every session in one place
 *   - `subscribeSessionStates(listener)` returns an `initial` snapshot
 *     (disk + memory union, see `getAllSessionStates`) PLUS attaches the
 *     listener to the daemon-wide fan-out so subsequent edges get pushed
 *   - the manager owns the disk read of `SidecodeSessionMetadata` and the
 *     merge with `SessionRuntime` live fields — `buildSessionState`
 *     centralizes the precedence (`runtime > disk` for live fields,
 *     `disk only` for static fields like cwd/title/createdAt)
 *
 * Generic over the same event type as SessionRuntime — the daemon picks
 * the concrete type at composition time (likely a TimelineItem-delta union
 * once F2 lands).
 */

import type { SessionState } from "@sidecodeapp/protocol";
import {
  listSidecodeSessions,
  readSidecodeSession,
  type SidecodeSessionMetadata,
  updateSidecodeSessionLastActivity,
} from "../sidecode-sessions.js";
import {
  type SessionActivity,
  SessionRuntime,
  type SessionRuntimeOptions,
} from "./session-runtime.js";

/**
 * #17 — listener for daemon-wide SessionState fan-out. Router wires one
 * per `subscribeSessions` subscriber; the manager's
 * `subscribeSessionStates` adds it to the listener set.
 *
 * `onChange` fires whenever any SessionState field iOS observes changes
 * (activity / model / lastActivityAt — see SessionRuntime's
 * onStateChanged option for the trigger semantics). Synchronous; listener
 * impl must be cheap.
 *
 * `onRemove` is reserved for V0.5+ — V0 sessions only become archived
 * (`isArchived: true`), never disappear from the list, so this method is
 * structurally never called in V0. Kept in the interface so the protocol
 * `session_state_removed` envelope has a wiring point when the feature
 * lands (e.g. user-driven delete).
 */
export interface SessionStateListener {
  onChange: (sessionId: string, state: SessionState) => void;
  onRemove: (sessionId: string) => void;
}

export class SessionRuntimeManager<T> {
  private readonly runtimes = new Map<string, SessionRuntime<T>>();
  private readonly defaultOptions: SessionRuntimeOptions<T>;
  private readonly stateListeners = new Set<SessionStateListener>();
  /** Sidecode home dir for disk reads. Optional so unit tests can build
   *  a memory-only manager without touching the filesystem. Production
   *  daemon calls `setHome` right after construction in `index.ts`. */
  private home: string | null = null;
  /** #17 — most recently OBSERVED activity per session (from the runtime
   *  callback's perspective). Used to detect the running→idle edge for
   *  turn-complete disk persistence in `notifyStateChanged`. setActivity
   *  dedupes on its own activity field, so this map's edge-detection
   *  agrees with "did the runtime just transition" — they never disagree
   *  in V0. Cleaned up on `delete(sessionId)`. */
  private readonly lastSeenActivity = new Map<string, SessionActivity>();

  constructor(defaults: SessionRuntimeOptions<T> = {}) {
    this.defaultOptions = defaults;
  }

  /** Late-binds the sidecode home so `getAllSessionStates` /
   *  `notifyStateChanged` can read disk metadata. No-op-safe to call
   *  more than once (same dir each time in production). */
  setHome(home: string): void {
    this.home = home;
  }

  has(sessionId: string): boolean {
    return this.runtimes.has(sessionId);
  }

  get(sessionId: string): SessionRuntime<T> | undefined {
    return this.runtimes.get(sessionId);
  }

  /**
   * Lazy-create. If a runtime already exists for `sessionId`, returns it
   * unchanged — `options` is only consulted on first creation.
   *
   * #17: every created runtime gets its `onStateChanged` callback wired
   * to the manager's `notifyStateChanged`, overriding any caller-supplied
   * value (V0 has no use case for a caller-owned state callback; the
   * manager is the single fan-out point). `currentModel` is seeded from
   * on-disk `SidecodeSessionMetadata.model` if available so re-attach
   * paths AND the first state snapshot reflect the persisted picker
   * selection without waiting for a setSessionSelection round-trip.
   */
  getOrCreate(
    sessionId: string,
    options?: SessionRuntimeOptions<T>,
  ): SessionRuntime<T> {
    const existing = this.runtimes.get(sessionId);
    if (existing !== undefined) return existing;
    const merged: SessionRuntimeOptions<T> = {
      ...this.defaultOptions,
      ...(options ?? {}),
      // #17 — manager-owned fan-out; caller-supplied onStateChanged would
      // bypass the daemon-wide listener set, which is never what we want.
      onStateChanged: (sid: string) => this.notifyStateChanged(sid),
    };
    const created = new SessionRuntime<T>(sessionId, merged);
    if (this.home !== null) {
      const meta = readSidecodeSession(this.home, sessionId);
      if (meta?.model !== undefined) {
        // Direct field assignment (not setModel) — at construction time
        // there are no listeners attached yet, and even if there were,
        // initial-state seeding shouldn't look like a "change" event.
        created.currentModel = meta.model;
      }
    }
    this.runtimes.set(sessionId, created);
    // Seed edge-detection state to match the runtime's constructor default.
    this.lastSeenActivity.set(sessionId, "idle");
    return created;
  }

  /** Drop the runtime for `sessionId`. Returns true iff it existed. */
  delete(sessionId: string): boolean {
    this.lastSeenActivity.delete(sessionId);
    return this.runtimes.delete(sessionId);
  }

  size(): number {
    return this.runtimes.size;
  }

  /** Iterate all live runtimes (used by F3's graceful shutdown). */
  values(): IterableIterator<SessionRuntime<T>> {
    return this.runtimes.values();
  }

  /**
   * #17 — subscribe to daemon-wide SessionState changes.
   *
   * Returns:
   *   - `initial`: a one-time snapshot of every known session (disk +
   *     memory union — see `getAllSessionStates`). Router emits these via
   *     `subscribeSessions.response.initial` so the iOS TanStack DB
   *     collection seeds without needing a separate listSessions RPC.
   *   - `unsubscribe`: idempotent closure to detach the listener (used
   *     by router on WebRTC peer disconnect).
   *
   * The listener fires synchronously from inside every SessionRuntime's
   * onStateChanged callback path. A throwing listener is caught + isolated
   * so a buggy iOS subscriber can't poison the manager's fan-out for
   * other peers.
   */
  subscribeSessionStates(listener: SessionStateListener): {
    initial: Array<{ sessionId: string; state: SessionState }>;
    unsubscribe: () => void;
  } {
    const initial = this.getAllSessionStates();
    this.stateListeners.add(listener);
    return {
      initial,
      unsubscribe: () => {
        this.stateListeners.delete(listener);
      },
    };
  }

  /**
   * #17 — disk + memory union of every known session's SessionState.
   *
   * Sources:
   *   - on-disk `<home>/sessions/local_<id>.json` via
   *     `listSidecodeSessions` (the source of truth for static fields
   *     title / cwd / createdAt / isArchived / completedTurns /
   *     permissionMode AND the persisted model selection)
   *   - in-memory `SessionRuntime` entries (the source of truth for live
   *     activity / lastActivityAt / currentModel)
   *
   * Order is unspecified — router emits to iOS, the TanStack DB
   * collection sorts via `useLiveQuery`.
   *
   * V0 disk-scan cost: synchronous `readFileSync` per file inside
   * `listSidecodeSessions`. At V0 scale (single-digit sessions) this is
   * ~ms; if profile shows it hot at higher scale, layer a cache.
   */
  getAllSessionStates(): Array<{
    sessionId: string;
    state: SessionState;
  }> {
    const disks = this.home === null ? [] : listSidecodeSessions(this.home);
    const byId = new Map<string, SidecodeSessionMetadata>();
    for (const d of disks) byId.set(d.cliSessionId, d);

    const allIds = new Set<string>();
    for (const id of byId.keys()) allIds.add(id);
    for (const id of this.runtimes.keys()) allIds.add(id);

    const out: Array<{ sessionId: string; state: SessionState }> = [];
    for (const id of allIds) {
      const state = buildSessionState(
        byId.get(id) ?? null,
        this.runtimes.get(id) ?? null,
      );
      if (state !== null) out.push({ sessionId: id, state });
    }
    return out;
  }

  /**
   * Manager-internal fan-out fired by every SessionRuntime's
   * `onStateChanged` callback. Three concerns, in order:
   *
   *   1. Turn-complete disk persistence (running → idle edge) — bumps
   *      `lastActivityAt` + `completedTurns` in
   *      `<home>/sessions/local_<id>.json` so daemon restart preserves
   *      the iOS list sort key + turn count. NO-OP when meta missing
   *      (Desktop-mirror / pre-first-prompt sidecode session) or when
   *      this onStateChanged fire isn't a running→idle edge (e.g.
   *      setModel firing while runtime is idle).
   *
   *   2. State fan-out — merge fresh disk meta (possibly updated by
   *      step 1) + runtime live fields via `buildSessionState`, push
   *      to every listener. Iso-isolated against listener throws.
   *
   * Step 1 always runs (sidecode-owned session metadata MUST stay
   * accurate across daemon restarts regardless of iOS connectivity).
   * Step 2 short-circuits when no listeners are attached so the merge +
   * fan-out cost is zero during the "no iOS connected" path.
   */
  private notifyStateChanged(sessionId: string): void {
    const runtime = this.runtimes.get(sessionId) ?? null;
    // Re-read disk meta first — both turn-complete persist AND fan-out
    // need it, so share one syscall.
    let meta =
      this.home === null
        ? null
        : (readSidecodeSession(this.home, sessionId) ?? null);

    // Turn-complete edge detection: setActivity fired this callback for a
    // genuine activity transition (it dedupes idle→idle / running→running
    // before calling onStateChanged), so if prior was "running" and
    // current is "idle" we just completed a turn. setModel fires this
    // callback too, but with no activity change — those cases pass through
    // without bumping completedTurns.
    const prior = this.lastSeenActivity.get(sessionId);
    const current: SessionActivity = runtime?.activity ?? "idle";
    if (current !== prior) {
      this.lastSeenActivity.set(sessionId, current);
      if (
        prior === "running" &&
        current === "idle" &&
        this.home !== null &&
        meta !== null &&
        runtime !== null
      ) {
        const merged = updateSidecodeSessionLastActivity(
          this.home,
          sessionId,
          runtime.lastActivityAt,
          meta.completedTurns + 1,
        );
        if (merged !== undefined) meta = merged;
      }
    }

    if (this.stateListeners.size === 0) return;
    const state = buildSessionState(meta, runtime);
    if (state === null) return;
    for (const listener of this.stateListeners) {
      try {
        listener.onChange(sessionId, state);
      } catch {
        // Isolation: a flaky iOS subscriber must not break sibling fan-out
        // or the runtime's tight onStateChanged path that triggered us.
      }
    }
  }

  /**
   * Daemon-shutdown drain: for every runtime in parallel, fire `query.close()`
   * (which kicks off SDK's internal 5s grace + abort fallback) then await
   * the runtime's `loopPromise` so the consumer loop's finally{} block runs
   * before this method returns. The await is bounded by `timeoutMs` per
   * runtime to keep a stuck loop from hanging the whole shutdown.
   *
   * Drops every entry from the map afterward, regardless of whether each
   * runtime drained cleanly or timed out — process is exiting either way,
   * leaking entries is harmless.
   *
   * `query.close()` is the only correct daemon-shutdown call for V0:
   *   - SDK doc claims `close()` is "forceful" but the actual sdk.mjs
   *     impl does inputStream.done() + 5s grace timer before abort.
   *   - `interrupt()` would speed shutdown of in-flight turns from ~5s to
   *     ~hundreds of ms, but only matters if shutdown latency is felt.
   *     Keep this method simple; revisit if measured shutdowns lag.
   *
   * See project_session_replay_model memory for the full lifecycle policy
   * and why `inputChannel.end()` is redundant here (close() already calls
   * `inputStream.done()` on the SDK's wrapper).
   */
  async shutdown(timeoutMs = 5000): Promise<void> {
    const tasks = [...this.runtimes.values()].map(async (runtime) => {
      try {
        runtime.query?.close();
      } catch {
        // close() is sync void and shouldn't throw, but defensive.
      }
      if (runtime.loopPromise) {
        // Per-runtime timeout: a stuck loop shouldn't hang the whole drain.
        // Outer process-level forceExit (in bin/sidecode.ts) is the final
        // safety net for catastrophic hangs.
        await Promise.race([
          runtime.loopPromise.catch(() => {}),
          new Promise<void>((resolve) => {
            setTimeout(resolve, timeoutMs).unref();
          }),
        ]);
      }
    });
    await Promise.all(tasks);
    this.runtimes.clear();
  }
}

/**
 * #17 — merge on-disk static fields with in-memory live fields into the
 * protocol `SessionState` shape.
 *
 * Precedence:
 *   - live fields (activity / lastActivityAt / currentModel): runtime
 *     wins; fall back to disk; fall back to a default
 *   - static fields (title / cwd / createdAt / isArchived /
 *     completedTurns / permissionMode): disk only — these are owned by
 *     `SidecodeSessionMetadata` and runtime doesn't know them
 *
 * Returns null only when BOTH inputs are null (no source — caller should
 * filter this row out). In V0 this can briefly happen between
 * `manager.getOrCreate` and the first `writeSidecodeSession` if a runtime
 * is created before its metadata file lands; we surface the runtime-only
 * row with sensible defaults rather than dropping it so the iOS list
 * doesn't flicker.
 */
function buildSessionState<T>(
  meta: SidecodeSessionMetadata | null,
  runtime: SessionRuntime<T> | null,
): SessionState | null {
  if (meta === null && runtime === null) return null;
  const fallbackTs = meta?.createdAt ?? Date.now();
  return {
    activity: runtime?.activity ?? "idle",
    model: runtime?.currentModel ?? meta?.model ?? null,
    lastActivityAt:
      runtime?.lastActivityAt ?? meta?.lastActivityAt ?? fallbackTs,
    title: meta?.title ?? "",
    cwd: meta?.cwd ?? "",
    createdAt: meta?.createdAt ?? fallbackTs,
    isArchived: meta?.isArchived ?? false,
    completedTurns: meta?.completedTurns ?? 0,
    permissionMode: meta?.permissionMode ?? "bypassPermissions",
  };
}
