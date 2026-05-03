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
 * Just the lifecycle methods we care about from the SDK Query type. Lets
 * F1 stay SDK-free; F2 plugs in the real Query (which structurally
 * satisfies this) without changing this file.
 */
export interface RuntimeQueryHandle {
  interrupt(): Promise<void>;
  close(): void;
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
  /** SDK query handle slot; populated by F2 when sendPrompt spawns query(). */
  query: RuntimeQueryHandle | null = null;

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
