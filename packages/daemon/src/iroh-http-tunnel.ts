// The daemon's second iroh ALPN (`thinkite/http/1`): a plain-HTTP/1.1
// reverse tunnel to the opencode server. One bi-stream carries one HTTP/1.1
// connection; the duplex adapter feeds each stream into a non-listening
// proxy server. Connections arrive pre-authenticated — the known_clients
// gate in IrohPeerServer runs before the tunnel sees them, and Basic auth
// toward opencode is injected inside the proxy so the password never
// leaves the daemon.

import type http from "node:http";
import type { Connection } from "@number0/iroh";
import { irohDuplex } from "./iroh-duplex.ts";
import type { OpencodeConnection } from "./opencode/registry.ts";
import { createProxyServer } from "./opencode-proxy.ts";

export interface IrohHttpTunnelOptions {
  /** The registered opencode service (`Daemon.opencode()`), resolved per request. */
  opencode: () => Promise<OpencodeConnection>;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export class IrohHttpTunnel {
  private readonly proxy: http.Server;
  private readonly log: NonNullable<IrohHttpTunnelOptions["log"]>;
  private readonly conns = new Set<Connection>();
  private stopped = false;

  constructor(opts: IrohHttpTunnelOptions) {
    this.log = opts.log ?? (() => undefined);
    this.proxy = createProxyServer({
      getUpstream: opts.opencode,
      log: this.log,
    });
  }

  /** Active tunnel connections (one QUIC connection carries N bi-streams). */
  activeConnections(): number {
    return this.conns.size;
  }

  /**
   * Feed one accepted HTTP-ALPN connection to the proxy: accept bi-streams
   * in a loop, each one becoming an HTTP/1.1 connection. Resolves when the
   * peer closes; callers fire-and-forget so the accept loop keeps going.
   */
  async serveConnection(conn: Connection): Promise<void> {
    if (this.stopped) {
      conn.close(0n, []);
      return;
    }
    this.conns.add(conn);
    this.log("iroh.http.accepted", {
      remoteId: conn.remoteId().toString(),
      stableId: conn.stableId(),
    });
    try {
      while (!this.stopped) {
        const bi = await conn.acceptBi(); // one bi-stream == one HTTP connection
        const sock = irohDuplex(bi, (m) =>
          this.log("iroh.http.stream", {
            stableId: conn.stableId(),
            message: m,
          }),
        );
        this.proxy.emit("connection", sock);
      }
    } catch (err) {
      // A reset/closed connection ends the accept loop — expected on client
      // disconnect, so this is informational rather than an error.
      this.log("iroh.http.closed", {
        stableId: conn.stableId(),
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.conns.delete(conn);
    }
  }

  /** Close every tunnel connection + the proxy. Idempotent. */
  stop(): void {
    this.stopped = true;
    for (const conn of this.conns) {
      try {
        conn.close(0n, []);
      } catch {
        // already closed
      }
    }
    this.conns.clear();
    this.proxy.closeAllConnections();
    this.proxy.close();
  }
}
