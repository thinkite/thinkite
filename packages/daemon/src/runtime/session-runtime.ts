/**
 * Per-session in-memory state for streaming/live messaging. Holds:
 *   - a ring buffer of events the daemon has pushed (for replay on subscribe)
 *   - a monotonic cursor assigned on each addEvent
 *   - a set of live subscriber callbacks (for fanout)
 *   - a slot for the SDK Query handle (populated by F2's run-query)
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
  /** Mid-session control plane. Router's `setSessionSelection` handler
   *  uses a single `applyFlagSettings` call carrying BOTH `model` and
   *  `effortLevel` since the SDK's `Settings` type has both keys —
   *  passing `model` here behaves identically to the dedicated
   *  `setModel()` setter (upstream docs), so we never need the latter.
   *
   *  Optional in this interface because router tests inject a stub
   *  query without it; production SDK `Query` always has both methods
   *  (sdk.d.ts:2138 setModel, 2178 applyFlagSettings).
   *
   *  NOTE: `Settings.effortLevel` enum excludes `'max'` (sdk.d.ts:5179),
   *  so the router gates the call on `effort !== 'max'`. Sessions
   *  whose initial query was spawned with `effort: 'max'` keep that
   *  level silently; the picker doesn't offer max in V0. */
  applyFlagSettings?(settings: {
    model?: string | null;
    effortLevel?: string | null;
  }): Promise<void>;
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

export interface RuntimeEvent<T> {
  /** Monotonically increasing per-runtime; assigned by addEvent. */
  cursor: number;
  payload: T;
}

export type Subscriber<T> = (event: RuntimeEvent<T>) => void;

export interface SessionRuntimeOptions {
  /** Max events retained in the ring. Oldest evicted on overflow. */
  bufferCap?: number;
}

export class SessionRuntime<T> {
  readonly sessionId: string;
  /** SDK query handle slot; populated by F2 when ensureSessionLoop spawns query(). */
  query: RuntimeQueryHandle | null = null;
  /** Streaming-input channel; populated by F2 alongside `query`. Used by F2's pushPrompt to feed new user prompts into the live SDK process. */
  inputChannel: RuntimeInputChannel | null = null;
  /** Promise that resolves when F2's consumer loop exits (graceful close, error, or natural end-of-iterator). Null when no loop is active. F3's daemon shutdown awaits this per runtime. */
  loopPromise: Promise<void> | null = null;

  private readonly bufferCap: number;
  private readonly buffer: RuntimeEvent<T>[] = [];
  private readonly subscribers = new Set<Subscriber<T>>();
  private nextCursor = 1;

  constructor(sessionId: string, options: SessionRuntimeOptions = {}) {
    this.sessionId = sessionId;
    this.bufferCap = options.bufferCap ?? 500;
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
