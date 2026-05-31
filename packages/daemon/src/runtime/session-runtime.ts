import type { TimelineItem, TurnUsage } from "@sidecodeapp/protocol";

/**
 * Per-session in-memory state for streaming/live messaging. Holds:
 *   - a ring buffer of events the daemon has pushed (for replay on subscribe)
 *   - a monotonic cursor assigned on each addEvent
 *   - a set of live subscriber callbacks (for fanout)
 *   - a slot for the SDK Query handle (populated by F2's run-query)
 *   - in-memory settled snapshot (refreshed at turn boundaries by run-query)
 *     so subscribe-time cold path can serve atomically from memory instead
 *     of racing with the live event stream over an async JSONL read
 *
 * Generic over `T` so callers can store whatever payload type makes sense
 * (TimelineItem delta, raw SDK message, etc.). F1 stays decoupled from the
 * SDK — only shapes the data + lifecycle.
 *
 * Buffer semantics:
 *   - cursors start at 1; `sinceCursor: 0` means "replay everything"
 *   - `subscribe(cb, sinceCursor=0)` synchronously replays buffered events
 *     with `cursor > sinceCursor`, then keeps cb in the subscriber set
 *   - if the requested `sinceCursor` is older than `oldestCursor`, caller
 *     is responsible for filling the gap from settled state (JSONL on disk
 *     via getSessionMessages) — runtime only guarantees what's in the ring
 *   - bufferCap defaults to 500 events
 *
 * Settled semantics:
 *   - `settled` is null until something populates it: either run-query's
 *     turn-boundary refresh (after each `result` envelope) or a lazy
 *     cold-path init from the router's subscribe handler.
 *   - `settledCursor` is the cursor that `settled` corresponds to — i.e.
 *     replay of buffer events with cursor > settledCursor reconstructs
 *     state from settled onward. Set atomically with `settled`.
 *   - The settled snapshot is for OUR own runtime's session. For sessions
 *     replayed from disk (no SDK loop running here), settled stays null
 *     and cold path always reads JSONL fresh.
 */

/**
 * Just the lifecycle methods we care about from the SDK Query type.
 * F2 assigns a real SDK Query (which structurally satisfies this) — no
 * changes to this file needed when SDK signatures evolve, as long as
 * `interrupt`/`close` shapes stay stable.
 */
export interface RuntimeQueryHandle {
  interrupt(): Promise<void>;
  close(): void;
  /** Mid-session model swap. Router's `setSessionSelection` handler
   *  uses this. Passing `model` via applyFlagSettings behaves
   *  identically to the dedicated `setModel()` setter per upstream
   *  docs — so we use this one and skip setModel.
   *
   *  Optional in this interface because router tests inject a stub
   *  query without it; production SDK `Query` always has the method
   *  (sdk.d.ts:2178). */
  applyFlagSettings?(settings: { model?: string | null }): Promise<void>;
}

/**
 * Structural slot for an `AsyncMessageInput<SDKUserMessage>` channel that
 * F2 stuffs in. We intentionally avoid importing the SDK type here so
 * SessionRuntime stays a pure data structure — `push` taking `unknown`
 * is contravariant-friendly and a typed `AsyncMessageInput<T>` assigns
 * cleanly. F2 holds the typed reference internally for actual pushing.
 */
export interface RuntimeInputChannel {
  push(msg: unknown): void;
  end(): void;
}

/**
 * Structural slot for the CCR bridge mirror (BridgeTransport, slice M1).
 * The query loop forwards each raw SDKMessage here in parallel with the
 * enriched EventDelta fan-out, so a bridged session streams to claude.ai
 * without SessionRuntime importing the SDK or the @alpha `/bridge` types.
 *
 * `write` takes `unknown` (same SDK-decoupling rationale as
 * `RuntimeInputChannel.push`) — BridgeTransport holds the typed SDKMessage
 * internally. Lifecycle is owned by BridgeTransport, NOT the query loop:
 * the loop's finally clears query/inputChannel/loopPromise but deliberately
 * leaves `bridge` intact, so a bridge outlives an idle (lazy) query — the
 * multiplex invariant from project_sidecode_ccr_architecture.
 */
export interface RuntimeBridge {
  /** Forward one raw SDKMessage to the cloud mirror (non-result frames). */
  write(msg: unknown): void;
  /** Signal turn completion (claude.ai stops its "working" spinner). */
  sendResult(): void;
  /**
   * Report the session's busy/idle state to the CCR worker endpoint so
   * claude.ai shows it as running vs idle. `"running"` on turn start,
   * `"idle"` on turn end. (`"requires_action"` is for permission prompts —
   * V0 deferred per project_no_plan_mode_v0 / no can_use_tool wiring; revisit
   * when iOS gains an approval sheet.) Empirically REQUIRED: without it a
   * bridged session never enters `running` on claude.ai (verified in M1.5
   * spike — see project_sidecode_ccr_architecture).
   */
  reportState(state: "idle" | "running" | "requires_action"): void;
  /** Tear down the bridge transport. */
  close(): void;
}

export interface RuntimeEvent<T> {
  /** Monotonically increasing per-runtime; assigned by addEvent. */
  cursor: number;
  payload: T;
}

export type Subscriber<T> = (event: RuntimeEvent<T>) => void;

export interface SessionRuntimeOptions<T> {
  /** Max events retained in the ring. Oldest evicted on overflow. */
  bufferCap?: number;
  /**
   * Continuous-fold reducer. When set, `addEvent` applies each delta to
   * the in-memory `settled` snapshot (if non-null), keeping it current so
   * the cold path serves a complete snapshot with `settledCursor ==
   * currentCursor` — no per-turn JSONL re-read. Production wires
   * `foldEventDelta` (messages/fold.ts), which mirrors the iOS reducer.
   * Left unset in tests that don't exercise the fold.
   */
  foldDelta?: (settled: TimelineItem[], delta: T) => TimelineItem[];
}

export class SessionRuntime<T> {
  readonly sessionId: string;
  /** SDK query handle slot; populated by F2 when ensureSessionLoop spawns query(). */
  query: RuntimeQueryHandle | null = null;
  /** Streaming-input channel; populated by F2 alongside `query`. Used by F2's pushPrompt to feed new user prompts into the live SDK process. */
  inputChannel: RuntimeInputChannel | null = null;
  /** Promise that resolves when F2's consumer loop exits (graceful close, error, or natural end-of-iterator). Null when no loop is active. F3's daemon shutdown awaits this per runtime. */
  loopPromise: Promise<void> | null = null;

  /** CCR bridge mirror slot (slice M1). Null = pure session (WebRTC only).
   *  Set by BridgeTransport.attach, cleared by its detach — NOT by the query
   *  loop's finally (a bridge must outlive an idle lazy query). When non-null,
   *  the consumer loop forwards each raw SDKMessage here, and pushPrompt
   *  mirrors the user prompt — see run-query's `forwardToBridge`. */
  bridge: RuntimeBridge | null = null;

  /** In-memory normalized snapshot of the transcript, so cold-path
   *  subscribes serve directly from memory. Maintained by CONTINUOUS FOLD:
   *  `addEvent` applies each delta via `foldDelta` (mirrors the iOS
   *  reducer + normalize.ts), so settled stays current with zero JSONL
   *  re-reads — no dependency on the SDK's async flush timing. Null until
   *  seeded: the create-mode `[]` seed (run-query) for sessions we drive,
   *  or the router's cold-path `deps.getMessages` lazy-init for resumed /
   *  Desktop-mirror sessions; folding resumes once non-null. Imports
   *  TimelineItem from protocol because that's the one shape we stash. */
  settled: TimelineItem[] | null = null;
  /** Cursor that `settled` corresponds to. With continuous fold this
   *  tracks `currentCursor` (settled reflects every event so far), so the
   *  cold-path replay window (settledCursor, currentCursor] is empty —
   *  settled IS the full snapshot. (Set to currentCursor on each fold; set
   *  by the router's lazy-init read for the no-fold seed case.) */
  settledCursor = 0;
  /** Latest turn usage stats (input tokens / cache tokens). Updated
   *  live whenever a `turn_completed` event is added with usage AND
   *  reloaded at turn-boundary refresh as belt-and-suspenders. Null
   *  for sessions whose most recent turn was tool-only or that haven't
   *  completed a turn yet on this runtime. */
  latestUsage: TurnUsage | null = null;
  /** Set by the interrupt RPC (router) right before `query.interrupt()`.
   *  On interrupt the SDK ends the in-flight turn with an
   *  `error_during_execution` result envelope; this flag tells
   *  handleResultEnvelope (and the loop's catch) to treat that as a user
   *  cancel — the router already emitted `turn_canceled` — instead of
   *  surfacing a spurious `turn_failed`. Consumed (reset) when that
   *  terminal envelope / throw is handled, on the next prompt, and on
   *  loop exit, so it never leaks into a later turn. */
  interrupted = false;

  private readonly bufferCap: number;
  private readonly buffer: RuntimeEvent<T>[] = [];
  private readonly subscribers = new Set<Subscriber<T>>();
  private nextCursor = 1;
  private readonly foldDelta?: (
    settled: TimelineItem[],
    delta: T,
  ) => TimelineItem[];

  constructor(sessionId: string, options: SessionRuntimeOptions<T> = {}) {
    this.sessionId = sessionId;
    this.bufferCap = options.bufferCap ?? 500;
    this.foldDelta = options.foldDelta;
  }

  /** Cursor of the oldest event still in the buffer, or null if empty. */
  get oldestCursor(): number | null {
    return this.buffer[0]?.cursor ?? null;
  }

  /** Cursor of the most-recently assigned event, or 0 if no events yet. */
  get currentCursor(): number {
    return this.nextCursor - 1;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /**
   * True iff no live subscribers and no active SDK query. V0 doesn't
   * auto-GC idle runtimes (see project_session_replay_model memory) — this
   * is an introspection helper for tests + a future opt-in GC pass.
   */
  get isIdle(): boolean {
    return this.subscribers.size === 0 && this.query === null;
  }

  /**
   * Append an event. Assigns the next cursor, evicts the oldest if the
   * buffer is over cap, then fanouts synchronously to all subscribers.
   *
   * Subscriber exceptions propagate — caller wraps callbacks that may
   * throw. (V0 producers are internal so we trust them.)
   */
  addEvent(payload: T): RuntimeEvent<T> {
    const event: RuntimeEvent<T> = { cursor: this.nextCursor++, payload };
    this.buffer.push(event);
    if (this.buffer.length > this.bufferCap) {
      this.buffer.shift();
    }
    // Continuous fold: keep `settled` current (settledCursor == this event)
    // so the cold path serves a complete in-memory snapshot with an empty
    // replay window — no per-turn JSONL re-read. Only folds once `settled`
    // is initialized (the create-mode `[]` seed, or the subscribe lazy-init
    // JSONL read); a null `settled` means "no snapshot yet — the next
    // subscribe seeds it from disk", and folding resumes after that. The
    // buffer above is untouched, so warm-reconnect replay is unaffected.
    if (this.settled !== null && this.foldDelta !== undefined) {
      this.settled = this.foldDelta(this.settled, payload);
      this.settledCursor = event.cursor;
    }
    for (const cb of this.subscribers) {
      cb(event);
    }
    return event;
  }

  /**
   * Subscribe `cb` to the event stream. Synchronously replays buffered
   * events with `cursor > sinceCursor`, then registers `cb` for future
   * fanouts. Returns an idempotent unsubscribe closure.
   *
   * Replay-then-attach order is deliberate: a callback that triggers
   * `addEvent` reentrantly during replay won't receive that new event on
   * this subscribe call — it lands in the buffer (and reaches future
   * subscribers via replay), but doesn't roundtrip mid-iteration. This
   * keeps replay ordering monotonic and avoids replay/live interleaving
   * weirdness. Production callers (router-side ws fanout) don't trigger
   * addEvent from inside the callback, so this only matters for tests.
   */
  subscribe(cb: Subscriber<T>, sinceCursor = 0): () => void {
    const replayStart = this.buffer.findIndex((e) => e.cursor > sinceCursor);
    if (replayStart >= 0) {
      const replay = this.buffer.slice(replayStart);
      for (const event of replay) {
        cb(event);
      }
    }
    this.subscribers.add(cb);

    let unsubscribed = false;
    return () => {
      if (unsubscribed) return;
      unsubscribed = true;
      this.subscribers.delete(cb);
    };
  }

  /**
   * Remove `cb` if present; returns true iff it was in the set. Equivalent
   * to calling the closure returned by `subscribe`, but useful when the
   * caller didn't keep that closure (e.g. ws.onclose iterating subscribers
   * registered through different paths).
   */
  unsubscribe(cb: Subscriber<T>): boolean {
    return this.subscribers.delete(cb);
  }
}
