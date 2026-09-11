import {
  type DaemonFrame,
  daemonFrame,
  PROTOCOL_VERSION,
} from "@thinkite/protocol";

// WebSocket client for the daemon's /rpc bridge — the local counterpart of
// iOS's daemon-client.ts, minus everything transport-establishment
// (iroh dial, pairing, version gating): the daemon lives in the
// server process this page was served from, so "connect" is one ws() call
// and the protocol package on both ends is the same import.
//
// Stage 2: session traffic (subscribeSessions / subscribe / sendPrompt /
// interrupt / setSessionSelection) moved to opencode v2 through the
// same-origin `/oc` proxy (see lib/oc.ts) — this module no longer carries
// any session API. `/rpc` itself stays (server route + daemon handlers
// untouched; iOS still uses them) for what is not opencode's (pairing,
// git status/diff, pty), so this file keeps the connection lifecycle only.
// Reconnect is silent and infinite (exponential backoff, 5s cap).

interface Pending {
  resolve: (frame: DaemonFrame) => void;
  reject: (err: Error) => void;
}

class DaemonRpc {
  #ws: WebSocket | null = null;
  #pending = new Map<string, Pending>();
  #backoff = 500;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;
  #connectPromise: Promise<void> | null = null;

  /** HMR hygiene: close the socket and stop reconnecting so a hot-swapped
   *  module instance doesn't leave a zombie connection alive on the
   *  daemon. */
  dispose(): void {
    this.#disposed = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#ws?.close();
  }

  /** True while the bridge socket is open. */
  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  /** Open the bridge socket (no-op when already open/connecting). */
  ensureConnected(): Promise<void> {
    if (this.#ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.#connectPromise !== null) return this.#connectPromise;
    this.#connectPromise = new Promise<void>((resolve, reject) => {
      if (this.#disposed) {
        reject(new Error("daemon rpc disposed"));
        return;
      }
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/rpc`);
      this.#ws = ws;
      ws.onopen = () => {
        this.#backoff = 500;
        this.#connectPromise = null;
        ws.send(
          JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }),
        );
        resolve();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") this.#onFrame(ev.data);
      };
      ws.onerror = () => {
        this.#connectPromise = null;
        reject(new Error("daemon connection failed"));
      };
      ws.onclose = () => {
        this.#ws = null;
        const dropped = new Error("daemon connection closed");
        for (const p of this.#pending.values()) p.reject(dropped);
        this.#pending.clear();
        if (this.#disposed) return;
        this.#reconnectTimer = setTimeout(() => {
          this.#connectPromise = null;
        }, this.#backoff);
        this.#backoff = Math.min(this.#backoff * 2, 5_000);
      };
    });
    return this.#connectPromise;
  }

  #onFrame(text: string): void {
    let frame: DaemonFrame;
    try {
      frame = daemonFrame.parse(JSON.parse(text));
    } catch (err) {
      console.warn("[daemon-rpc] dropped unparseable frame:", err);
      return;
    }
    switch (frame.type) {
      case "server_info":
      case "pong":
        return;
      default: {
        const requestId =
          "requestId" in frame ? (frame.requestId as string) : undefined;
        const pending =
          requestId === undefined ? undefined : this.#pending.get(requestId);
        if (pending === undefined) return;
        this.#pending.delete(requestId!);
        if (frame.type === "error") {
          pending.reject(new Error(`${frame.code}: ${frame.message}`));
        } else {
          pending.resolve(frame);
        }
      }
    }
  }
}

export const daemonRpc = new DaemonRpc();

if (import.meta.hot) {
  import.meta.hot.dispose(() => daemonRpc.dispose());
}
