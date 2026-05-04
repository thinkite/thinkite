import type { AddressInfo } from "node:net";
import {
  type ClientFrame,
  type Command,
  clientFrame,
  type DaemonFrame,
  HANDSHAKE_VERSION,
  type HandshakeRejectFrame,
} from "@sidecodeapp/protocol";
import { type WebSocket, WebSocketServer as WSCore } from "ws";
import type { PairingService } from "./pairing.js";

/** Context passed to each authenticated command. The handler uses `send`
 *  to push responses or events back to the connection. */
export interface CommandContext {
  send: (frame: DaemonFrame) => void;
  /** ed25519 fingerprint (16 hex chars) of the authenticated client. */
  fingerprint: string;
  /**
   * Register a callback to fire when this connection closes. Used by
   * subscription handlers (slice G2) to drop their runtime subscriber
   * fanouts on ws disconnect — implicit unsubscribe-all-for-this-conn.
   *
   * Callbacks fire in registration order. Exceptions are logged and
   * swallowed so one bad cleanup doesn't skip the rest. The same `cb`
   * reference can be registered multiple times — useful is rare; harmless
   * if it happens (just runs N times on close). Callers should ensure
   * the underlying cleanup is idempotent (SessionRuntime's unsubscribe
   * closures already are).
   */
  onDisconnect: (cb: () => void) => void;
}

/** Dispatched for every authenticated command frame. May be async. The
 *  ws-server catches thrown errors and emits an `error` frame; handlers
 *  that want a structured response should send it via `ctx.send` instead
 *  of throwing. */
export type CommandHandler = (
  cmd: Command,
  ctx: CommandContext,
) => void | Promise<void>;

/** Default address bound. 127.0.0.1 limits V0 to local LAN/loopback. */
export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 41234;

/** Per-connection auth state. Connections start in wait_hello and either
 *  advance to authenticated or get closed within `authTimeoutMs`. */
export type ConnectionAuthState =
  | "wait_hello"
  | "wait_auth"
  | "authenticated"
  | "closed";

interface Connection {
  ws: WebSocket;
  ip: string;
  state: ConnectionAuthState;
  /** Set after successful client.auth. */
  fingerprint?: string;
  /** sessionId being negotiated. Only meaningful in wait_auth state. */
  pendingSessionId?: string;
  /** setTimeout handle for the auth window. Cleared on state advance / close. */
  authTimer: ReturnType<typeof setTimeout> | null;
  /** Heartbeat: server's ping/pong tracking. */
  isAlive: boolean;
  /**
   * Cleanup callbacks fired on connection close — populated via
   * `ctx.onDisconnect()`. Used by slice G2's subscribe handler to drop
   * runtime fanout subscriptions when the ws disconnects.
   */
  disconnectCallbacks: Array<() => void>;
}

export interface WebSocketServerOptions {
  pairing: PairingService;
  /** Dispatcher for authenticated command frames. If absent, authenticated
   *  commands are logged and ignored (V0 W1 baseline / test convenience). */
  commandHandler?: CommandHandler;
  port?: number;
  host?: string;
  /** Time from connection open to authenticated state. Default 10s. */
  authTimeoutMs?: number;
  /** ws-library ping interval. Default 30s. */
  heartbeatIntervalMs?: number;
  /** Optional logger. V0: console; future: pino. */
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * Minimal WebSocket transport for the daemon.
 *
 * One server instance, multiple concurrent connections. Each connection
 * owns its own auth state machine, driven by frames from the client.
 * The PairingService is shared across all connections (it has internal
 * state for pending offers and transcripts that must be daemon-wide).
 *
 * V0 scope: handshake only. Once authenticated, this server does not yet
 * dispatch business commands (subscribe / sendPrompt / etc.) — those land
 * in Day 4 as a separate handler layer.
 */
export class WebSocketServer {
  private server: WSCore | null = null;
  private readonly connections = new Set<Connection>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Monotonic count of successful authentications since server started.
   *  Unlike authenticatedCount() this doesn't drop when clients disconnect,
   *  so pollers can detect "any client paired" reliably without races. */
  private totalAuths = 0;
  private readonly authTimeoutMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly log: NonNullable<WebSocketServerOptions["log"]>;
  private readonly host: string;
  private readonly port: number;

  constructor(private readonly options: WebSocketServerOptions) {
    this.authTimeoutMs = options.authTimeoutMs ?? 10_000;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
    this.host = options.host ?? DEFAULT_HOST;
    this.port = options.port ?? DEFAULT_PORT;
    this.log = options.log ?? (() => undefined);
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error("WebSocketServer already started");

    return new Promise((resolve, reject) => {
      const server = new WSCore({ host: this.host, port: this.port });
      server.once("listening", () => {
        const addr = server.address() as AddressInfo;
        this.server = server;
        this.startHeartbeat();
        this.log("server.listening", { host: addr.address, port: addr.port });
        resolve({ host: addr.address, port: addr.port });
      });
      server.once("error", (err) => reject(err));
      server.on("connection", (ws, req) =>
        this.onConnection(ws, req.socket.remoteAddress ?? "?"),
      );
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    // Terminate all connections (skip graceful close to avoid hanging).
    for (const conn of this.connections) {
      this.closeConnection(conn, 1001, "server shutting down");
    }
    return new Promise((resolve, reject) => {
      this.server?.close((err) => {
        this.server = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /** Number of connections in any state — for tests + diagnostics. */
  connectionCount(): number {
    return this.connections.size;
  }

  /** Number of connections that have completed the handshake. */
  authenticatedCount(): number {
    let n = 0;
    for (const c of this.connections) if (c.state === "authenticated") n += 1;
    return n;
  }

  /** Cumulative count of successful authentications since start(). */
  totalAuthenticatedCount(): number {
    return this.totalAuths;
  }

  // ─── Connection lifecycle ─────────────────────────────────────────────

  private onConnection(ws: WebSocket, ip: string): void {
    const conn: Connection = {
      ws,
      ip,
      state: "wait_hello",
      authTimer: null,
      isAlive: true,
      disconnectCallbacks: [],
    };
    this.connections.add(conn);
    this.log("conn.open", { ip });

    // Auth window timer: from connection open to authenticated state.
    conn.authTimer = setTimeout(() => {
      if (conn.state !== "authenticated" && conn.state !== "closed") {
        this.sendReject(
          conn,
          undefined,
          "session_expired",
          "auth window expired",
        );
        this.closeConnection(conn, 4001, "auth timeout");
      }
    }, this.authTimeoutMs);

    ws.on("message", (data) => this.onMessage(conn, data));
    ws.on("pong", () => {
      conn.isAlive = true;
    });
    ws.on("close", (code, reason) =>
      this.onClose(conn, code, reason.toString()),
    );
    ws.on("error", (err) => {
      this.log("conn.error", { ip, error: err.message });
    });
  }

  private onMessage(conn: Connection, data: unknown): void {
    if (conn.state === "closed") return;

    let frame: ClientFrame;
    try {
      const text =
        typeof data === "string" ? data : (data as Buffer).toString("utf8");
      frame = clientFrame.parse(JSON.parse(text));
    } catch (err) {
      this.log("conn.bad_frame", {
        ip: conn.ip,
        error: (err as Error).message,
      });
      this.sendReject(conn, undefined, "internal", "malformed frame");
      this.closeConnection(conn, 4002, "malformed frame");
      return;
    }

    switch (conn.state) {
      case "wait_hello":
        this.handleHello(conn, frame);
        return;
      case "wait_auth":
        this.handleAuth(conn, frame);
        return;
      case "authenticated":
        this.handleAuthenticated(conn, frame);
        return;
    }
  }

  private handleAuthenticated(conn: Connection, frame: ClientFrame): void {
    // Heartbeat ping is allowed at any post-handshake point.
    if (frame.type === "ping") {
      this.send(conn, { type: "pong", t: Date.now(), echoT: frame.t });
      return;
    }
    // Handshake frames after the handshake are protocol violations.
    if (frame.type === "client.hello" || frame.type === "client.auth") {
      this.log("conn.unexpected_handshake", {
        ip: conn.ip,
        frameType: frame.type,
      });
      return;
    }

    const handler = this.options.commandHandler;
    if (!handler) {
      this.log("conn.unhandled", { ip: conn.ip, frameType: frame.type });
      return;
    }
    const cmd = frame as Command;
    const ctx: CommandContext = {
      send: (f) => this.send(conn, f),
      // Auth state guarantees fingerprint is set; the assertion is safe.
      fingerprint: conn.fingerprint as string,
      onDisconnect: (cb) => {
        conn.disconnectCallbacks.push(cb);
      },
    };
    Promise.resolve()
      .then(() => handler(cmd, ctx))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log("conn.handler_error", {
          ip: conn.ip,
          frameType: frame.type,
          error: message,
        });
        const requestId =
          "requestId" in cmd
            ? (cmd as { requestId?: string }).requestId
            : undefined;
        this.send(conn, {
          type: "error",
          requestId,
          code: "internal",
          message: `handler error: ${message}`,
        });
      });
  }

  private handleHello(conn: Connection, frame: ClientFrame): void {
    if (frame.type !== "client.hello") {
      this.sendReject(
        conn,
        undefined,
        "internal",
        `expected client.hello, got ${frame.type}`,
      );
      this.closeConnection(conn, 4003, "wrong frame in wait_hello");
      return;
    }

    const result = this.options.pairing.processClientHello(frame);
    if (!result.ok) {
      this.send(conn, result.reject);
      this.closeConnection(conn, 4004, `hello rejected: ${result.reject.code}`);
      return;
    }
    conn.state = "wait_auth";
    conn.pendingSessionId = frame.sessionId;
    this.send(conn, result.serverHello);
  }

  private handleAuth(conn: Connection, frame: ClientFrame): void {
    if (frame.type !== "client.auth") {
      this.sendReject(
        conn,
        conn.pendingSessionId,
        "internal",
        `expected client.auth, got ${frame.type}`,
      );
      this.closeConnection(conn, 4005, "wrong frame in wait_auth");
      return;
    }
    if (frame.sessionId !== conn.pendingSessionId) {
      this.sendReject(
        conn,
        frame.sessionId,
        "session_unknown",
        "client.auth sessionId does not match this connection's pending hello",
      );
      this.closeConnection(conn, 4006, "session id mismatch");
      return;
    }

    const result = this.options.pairing.processClientAuth(frame);
    if (!result.ok) {
      this.send(conn, result.reject);
      this.closeConnection(conn, 4007, `auth rejected: ${result.reject.code}`);
      return;
    }
    conn.state = "authenticated";
    conn.fingerprint = result.client.fingerprint;
    this.totalAuths += 1;
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = null;
    }
    this.send(conn, result.ready);
    this.log("conn.authenticated", {
      ip: conn.ip,
      fingerprint: result.client.fingerprint,
    });
  }

  private onClose(conn: Connection, code: number, reason: string): void {
    if (conn.state === "closed") return;
    conn.state = "closed";
    if (conn.authTimer) {
      clearTimeout(conn.authTimer);
      conn.authTimer = null;
    }
    // Fire disconnect callbacks BEFORE we drop the conn from the set so
    // that any subscriber-cleanup-driven sends (extremely unlikely, but
    // theoretically a callback could try to send a final frame) still
    // reach this.send → ws.send. Exceptions in any one cb don't skip
    // the rest.
    for (const cb of conn.disconnectCallbacks) {
      try {
        cb();
      } catch (err) {
        this.log("conn.disconnect_cb_error", {
          ip: conn.ip,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    conn.disconnectCallbacks.length = 0;
    this.connections.delete(conn);
    this.log("conn.close", {
      ip: conn.ip,
      code,
      reason,
      fingerprint: conn.fingerprint,
    });
  }

  private closeConnection(
    conn: Connection,
    code: number,
    reason: string,
  ): void {
    if (conn.state === "closed") return;
    try {
      conn.ws.close(code, reason);
    } catch {
      try {
        conn.ws.terminate();
      } catch {
        // give up
      }
    }
    this.onClose(conn, code, reason);
  }

  private send(conn: Connection, frame: DaemonFrame): void {
    if (conn.state === "closed") return;
    try {
      conn.ws.send(JSON.stringify(frame));
    } catch (err) {
      this.log("conn.send_error", {
        ip: conn.ip,
        error: (err as Error).message,
      });
    }
  }

  private sendReject(
    conn: Connection,
    sessionId: string | undefined,
    code: HandshakeRejectFrame["code"],
    message: string,
  ): void {
    this.send(conn, {
      type: "handshake.reject",
      v: HANDSHAKE_VERSION,
      sessionId,
      code,
      message,
    });
  }

  // ─── Heartbeat ────────────────────────────────────────────────────────

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      for (const conn of this.connections) {
        if (!conn.isAlive) {
          this.log("conn.heartbeat_timeout", {
            ip: conn.ip,
            fingerprint: conn.fingerprint,
          });
          this.closeConnection(conn, 4008, "no pong");
          continue;
        }
        conn.isAlive = false;
        try {
          conn.ws.ping();
        } catch {
          this.closeConnection(conn, 4009, "ping failed");
        }
      }
    }, this.heartbeatIntervalMs);
    // Don't keep the process alive solely on the heartbeat timer.
    if (
      this.heartbeatTimer &&
      typeof this.heartbeatTimer.unref === "function"
    ) {
      this.heartbeatTimer.unref();
    }
  }
}
