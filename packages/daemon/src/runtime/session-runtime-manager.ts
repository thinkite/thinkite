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
