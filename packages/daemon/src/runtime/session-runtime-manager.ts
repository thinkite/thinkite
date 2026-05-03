/**
 * Holds all SessionRuntime instances for a daemon process. Lazy-creates
 * runtimes on `getOrCreate`; never auto-evicts (V0 GC policy: drop only on
 * daemon shutdown — see project_session_replay_model memory).
 *
 * Generic over the same event type as SessionRuntime — the daemon picks
 * the concrete type at composition time (likely a TimelineItem-delta union
 * once F2 lands).
 */

import {
  SessionRuntime,
  type SessionRuntimeOptions,
} from "./session-runtime.js";

export class SessionRuntimeManager<T> {
  private readonly runtimes = new Map<string, SessionRuntime<T>>();
  private readonly defaultOptions: SessionRuntimeOptions;

  constructor(defaults: SessionRuntimeOptions = {}) {
    this.defaultOptions = defaults;
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
   */
  getOrCreate(
    sessionId: string,
    options?: SessionRuntimeOptions,
  ): SessionRuntime<T> {
    const existing = this.runtimes.get(sessionId);
    if (existing !== undefined) return existing;
    const created = new SessionRuntime<T>(
      sessionId,
      options ?? this.defaultOptions,
    );
    this.runtimes.set(sessionId, created);
    return created;
  }

  /** Drop the runtime for `sessionId`. Returns true iff it existed. */
  delete(sessionId: string): boolean {
    return this.runtimes.delete(sessionId);
  }

  size(): number {
    return this.runtimes.size;
  }

  /** Iterate all live runtimes (used by F3's graceful shutdown). */
  values(): IterableIterator<SessionRuntime<T>> {
    return this.runtimes.values();
  }
}
