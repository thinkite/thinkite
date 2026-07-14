import {
  type Command,
  type DaemonFrame,
  daemonFrame,
  PROTOCOL_VERSION,
  type SessionState,
} from "@sidecodeapp/protocol";

// WebSocket client for the daemon's /rpc bridge — the local counterpart of
// iOS's daemon-client.ts, minus everything transport-establishment
// (signaling, pairing, WebRTC, version gating): the daemon lives in the
// server process this page was served from, so "connect" is one ws() call
// and the protocol package on both ends is the same import.
//
// Reconnect is silent and infinite (exponential backoff, 5s cap). In-flight
// requests reject on drop; registered subscriptions re-issue on the next
// open, and the daemon serves a fresh initial snapshot — which is exactly
// the truncate-then-insert contract the collection sync handlers expect.

export interface SessionsSubscription {
  onInitial(entries: Array<{ sessionId: string; state: SessionState }>): void;
  onChange(sessionId: string, state: SessionState): void;
  onRemove(sessionId: string): void;
}

interface Pending {
  resolve: (frame: DaemonFrame) => void;
  reject: (err: Error) => void;
}

class DaemonRpc {
  #ws: WebSocket | null = null;
  #pending = new Map<string, Pending>();
  #sessionsSub: SessionsSubscription | null = null;
  #backoff = 500;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #disposed = false;

  constructor() {
    this.#connect();
  }

  /** HMR hygiene: close the socket and stop reconnecting so a hot-swapped
   *  module instance doesn't leave a zombie connection (and its
   *  subscription fanout) alive on the daemon. */
  dispose(): void {
    this.#disposed = true;
    if (this.#reconnectTimer !== null) clearTimeout(this.#reconnectTimer);
    this.#ws?.close();
  }

  /**
   * Register the (single) sessions-stream consumer. Issues the
   * subscribeSessions RPC now if connected, and again after every
   * reconnect — each (re)issue delivers a fresh `onInitial` ground-truth
   * snapshot. Router-side cleanup is implicit on socket close, so
   * `unsubscribe` only stops local routing.
   */
  subscribeSessions(sub: SessionsSubscription): { unsubscribe(): void } {
    if (this.#sessionsSub !== null) {
      throw new Error("subscribeSessions: already subscribed");
    }
    this.#sessionsSub = sub;
    if (this.#ws?.readyState === WebSocket.OPEN) {
      void this.#issueSubscribeSessions();
    }
    return {
      unsubscribe: () => {
        if (this.#sessionsSub === sub) this.#sessionsSub = null;
      },
    };
  }

  /**
   * Send a user prompt into a session. Resolves when the daemon accepted
   * the turn (the reply itself streams via session state + JSONL).
   * `userMessageUuid` lets the caller optimistically render the bubble
   * under the same uuid the daemon will persist — dedupe by key, no
   * double bubble.
   */
  async sendPrompt(opts: {
    sessionId: string;
    text: string;
    cwd?: string;
    userMessageUuid?: string;
  }): Promise<void> {
    await this.#request({
      type: "sendPrompt",
      requestId: crypto.randomUUID(),
      ...opts,
    });
  }

  /** Stop the live turn — the session and subprocess stay alive for
   *  follow-up prompts. */
  async interrupt(sessionId: string): Promise<void> {
    await this.#request({
      type: "interrupt",
      requestId: crypto.randomUUID(),
      sessionId,
    });
  }

  /** Pick-time commit of the model selection (not bundled with sendPrompt):
   *  the daemon applies it to the live query via applyFlagSettings, then
   *  persists to session metadata. Rejects when the control-plane apply
   *  fails — callers roll back their optimistic picker state. */
  async setSessionSelection(sessionId: string, model: string): Promise<void> {
    await this.#request({
      type: "setSessionSelection",
      requestId: crypto.randomUUID(),
      sessionId,
      model,
    });
  }

  #connect(): void {
    if (this.#disposed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/rpc`);
    this.#ws = ws;
    ws.onopen = () => {
      this.#backoff = 500;
      ws.send(
        JSON.stringify({ type: "hello", protocolVersion: PROTOCOL_VERSION }),
      );
      if (this.#sessionsSub !== null) void this.#issueSubscribeSessions();
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") this.#onFrame(ev.data);
    };
    ws.onclose = () => {
      this.#ws = null;
      const dropped = new Error("daemon connection closed");
      for (const p of this.#pending.values()) p.reject(dropped);
      this.#pending.clear();
      if (this.#disposed) return;
      this.#reconnectTimer = setTimeout(() => this.#connect(), this.#backoff);
      this.#backoff = Math.min(this.#backoff * 2, 5_000);
    };
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
      case "session_state_changed":
        this.#sessionsSub?.onChange(frame.sessionId, frame.state);
        return;
      case "session_state_removed":
        this.#sessionsSub?.onRemove(frame.sessionId);
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

  #request(cmd: Command): Promise<DaemonFrame> {
    const ws = this.#ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("daemon connection not open"));
    }
    const requestId = (cmd as { requestId: string }).requestId;
    return new Promise<DaemonFrame>((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject });
      ws.send(JSON.stringify(cmd));
    });
  }

  async #issueSubscribeSessions(): Promise<void> {
    try {
      const res = await this.#request({
        type: "subscribeSessions",
        requestId: crypto.randomUUID(),
      });
      if (res.type === "subscribeSessions.response") {
        this.#sessionsSub?.onInitial(res.initial);
      }
    } catch (err) {
      // Connection dropped mid-flight — the reconnect path re-issues.
      console.warn("[daemon-rpc] subscribeSessions failed:", err);
    }
  }
}

export const daemonRpc = new DaemonRpc();

if (import.meta.hot) {
  import.meta.hot.dispose(() => daemonRpc.dispose());
}
