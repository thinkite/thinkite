// The daemon's third iroh ALPN (`thinkite/tcp/1`): the Mac's dev servers,
// reached from the phone as if they ran there. The app listens on its own
// 127.0.0.1:<port> (react-native-iroh-ffi's `forwardTcp`) and opens one
// bi-stream per TCP connection; each stream starts with the port to reach as
// two bytes, big-endian, and from then on carries that connection's bytes
// to `localhost:<port>` on the Mac and back. WebSocket upgrades (a dev
// server's hot reload) are just more bytes.
//
// Only the Mac's loopback is reachable: the target host is fixed, the
// stream only picks the port. Connections arrive pre-authenticated — the
// known_clients gate in IrohPeerServer runs first, the same gate that
// already lets a paired phone drive the agent.

import { connect, type Socket } from "node:net";
import type { BiStream, Connection } from "@number0/iroh";
import { IROH_TCP_HEADER_BYTES } from "@thinkite/protocol";
import { irohDuplex } from "./iroh-duplex.ts";

export interface IrohTcpTunnelOptions {
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export class IrohTcpTunnel {
  private readonly log: NonNullable<IrohTcpTunnelOptions["log"]>;
  private readonly conns = new Set<Connection>();
  private readonly sockets = new Set<Socket>();
  private stopped = false;

  constructor(opts: IrohTcpTunnelOptions = {}) {
    this.log = opts.log ?? (() => undefined);
  }

  /** Active tunnel connections (one QUIC connection carries N streams). */
  activeConnections(): number {
    return this.conns.size;
  }

  /** TCP connections currently open to the Mac's loopback. */
  activeSockets(): number {
    return this.sockets.size;
  }

  /**
   * Accept bi-streams on one TCP-ALPN connection until the peer closes;
   * each becomes one TCP connection. Callers fire-and-forget.
   */
  async serveConnection(conn: Connection): Promise<void> {
    if (this.stopped) {
      conn.close(0n, []);
      return;
    }
    this.conns.add(conn);
    this.log("iroh.tcp.accepted", { stableId: conn.stableId() });
    try {
      while (!this.stopped) {
        const bi = await conn.acceptBi();
        void this.serveStream(bi).catch((err: unknown) => {
          this.log("iroh.tcp.stream_error", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      this.log("iroh.tcp.closed", {
        stableId: conn.stableId(),
        reason: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.conns.delete(conn);
    }
  }

  private async serveStream(bi: BiStream): Promise<void> {
    const header = await bi.recv.readExact(IROH_TCP_HEADER_BYTES);
    const port = ((header[0] ?? 0) << 8) | (header[1] ?? 0);
    if (port === 0) {
      await bi.send.reset(0n).catch(() => {});
      await bi.recv.stop(0n).catch(() => {});
      this.log("iroh.tcp.bad_port", { port });
      return;
    }
    const stream = irohDuplex(bi);
    // "localhost" so both families are tried: dev servers bind to ::1 or
    // 127.0.0.1 depending on the tool.
    const socket = connect({ host: "localhost", port, noDelay: true });
    this.sockets.add(socket);
    const done = (reason: string) => {
      if (!this.sockets.delete(socket)) return;
      this.log("iroh.tcp.socket_closed", { port, reason });
    };
    socket.once("connect", () => {
      this.log("iroh.tcp.socket_open", { port });
      stream.pipe(socket);
      socket.pipe(stream);
    });
    // A clean close travels through the pipes as FINs both ways; only
    // failures reset the other side (a reset drops bytes still queued).
    socket.once("error", (err: NodeJS.ErrnoException) => {
      // A refused dial over both families is an AggregateError with no
      // message; its code says what happened.
      done(err.code ?? err.message);
      stream.destroy();
    });
    socket.once("close", () => done("closed"));
    stream.once("error", () => socket.destroy());
  }

  /** Close every tunnel connection and socket. Idempotent. */
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
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
  }
}
