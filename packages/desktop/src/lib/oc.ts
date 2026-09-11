import {
  createOcClient,
  type OcClient,
  type V2Event,
} from "@thinkite/oc-client";

// Renderer-wide opencode v2 access. Same-origin `/oc` (the Electron main
// reverse proxy injects Basic auth — credentials never reach this process),
// so one client serves the whole app.
//
// Subscriptions: each open session owns ONE durable stream (`after=`
// resume on reconnect, owned by its transcript collection); the global
// bus (`/api/event`: live-only deltas, session.status, session
// create/update/delete, permission/question asks) is a SINGLE shared
// async-iterator fan-out — every session stream needs the bus fragments
// routed by `sessionID`, and the session list needs the same bus. One
// connection, many subscribers; reconnects re-issue with backoff in the
// collection sync handlers, not here.

let client: OcClient | null = null;

export function getOcClient(): OcClient {
  if (client === null) {
    client = createOcClient({ baseUrl: `${location.origin}/oc` });
  }
  return client;
}

type BusSubscriber = (event: V2Event) => void;

class SharedBus {
  private subscribers = new Set<BusSubscriber>();
  private abort: AbortController | null = null;
  private running: Promise<void> | null = null;
  private backoff = 1000;

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
          for await (const event of getOcClient().openEventBus({
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

export const sharedOcBus = new SharedBus();

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // HMR hygiene: drop the singleton + bus so a hot-swapped module
    // instance doesn't leave a zombie stream (same dance as daemon-rpc).
    client = null;
  });
}

// ─── Model refs ────────────────────────────────────────────────────
// v2 model identity is `providerID/modelID` (split on the first `/` —
// model ids may contain `/`). The picker stores this string form.

export function parseModelRef(value: string): {
  providerID: string;
  id: string;
} {
  const slash = value.indexOf("/");
  if (slash < 0) return { providerID: value, id: "" };
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

export function formatModelRef(providerID: string, id: string): string {
  return `${providerID}/${id}`;
}
