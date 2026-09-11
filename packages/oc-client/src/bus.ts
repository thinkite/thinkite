/**
 * One shared `/api/event` connection per app, fanned out to subscribers.
 *
 * Every open session's transcript needs the live-only deltas routed by
 * `sessionID`, and the sessions collection needs the same stream for
 * `session.created/updated/deleted` plus turn boundaries — one connection
 * with many subscribers instead of one SSE per collection. The durable
 * per-session streams (with `after=` resume) are separate and owned by
 * their transcript collections; reconnects for those re-issue with
 * backoff in the collection sync handlers, not here.
 *
 * Framework-agnostic: takes the client (or a lazy factory for the app
 * singleton) instead of reaching for one.
 */

import type { OcClient, V2Event } from "./client.ts";

type BusSubscriber = (event: V2Event) => void;

export class SharedBus {
  private readonly getClient: () => OcClient;
  private subscribers = new Set<BusSubscriber>();
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;
  private backoff = 1000;

  constructor(client: OcClient | (() => OcClient)) {
    this.getClient = typeof client === "function" ? client : () => client;
  }

  subscribe(fn: BusSubscriber): () => void {
    this.subscribers.add(fn);
    if (this.subscribers.size === 1) void this.start();
    return () => {
      this.subscribers.delete(fn);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  private stop(): void {
    this.abort?.abort();
    this.abort = null;
    this.running = null;
  }

  private async start(): Promise<void> {
    if (this.running !== null) return this.running;
    this.running = (async () => {
      while (this.subscribers.size > 0) {
        const abort = new AbortController();
        this.abort = abort;
        try {
          for await (const event of this.getClient().openEventBus({
            signal: abort.signal,
          })) {
            this.backoff = 1000;
            for (const fn of [...this.subscribers]) {
              try {
                fn(event);
              } catch (err) {
                console.warn("[oc-bus] subscriber failed:", err);
              }
            }
          }
        } catch (err) {
          if (abort.signal.aborted || this.subscribers.size === 0) return;
          console.warn("[oc-bus] stream ended, retrying:", err);
        } finally {
          if (this.abort === abort) this.abort = null;
        }
        if (this.subscribers.size === 0) return;
        // The SDK stream retries internally on blips; reaching here means
        // the generator returned (abort or server tutup) — wait before
        // re-issuing so a down server isn't hammered.
        await new Promise((r) => setTimeout(r, this.backoff));
        this.backoff = Math.min(this.backoff * 2, 10_000);
      }
    })();
    return this.running;
  }
}
