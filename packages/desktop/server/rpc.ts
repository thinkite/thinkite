// WebSocket bridge from the renderer to the in-process daemon's command
// router — the local twin of the iOS WebRTC transport. Dumb by design: the
// daemon's LocalConnection owns frame parsing, validation, and error replies
// (invalid input is answered in-band, never thrown); this module only moves
// text and ties connection lifetime to socket lifetime.
//
// One LocalConnection per socket. Closing the socket fires the router's
// per-connection cleanups (subscription fanouts), so a reloaded webview
// never leaks subscribers.
//
// Bun.serve's websocket API is handler-per-server (not per-socket like
// Deno.upgradeWebSocket), so main.ts dispatches open/message/close here by
// ws.data.kind.
import type { Daemon } from "@sidecodeapp/daemon";
import type { Server, ServerWebSocket } from "bun";

export type RpcWsData = {
  kind: "rpc";
  conn: ReturnType<Daemon["connectLocal"]> | null;
};

type RpcSocket = ServerWebSocket<RpcWsData>;

export function rpcUpgrade(
  req: Request,
  server: Server,
  daemon: Daemon | null,
): Response | undefined {
  if (daemon === null) {
    // Another daemon owns ~/.sidecode (or startup failed) — the GUI shows
    // its daemon-offline state off this instead of a dead socket.
    return new Response("daemon not running in this process", { status: 503 });
  }
  const data: RpcWsData = { kind: "rpc", conn: null };
  return server.upgrade(req, { data })
    ? undefined
    : new Response("upgrade failed", { status: 400 });
}

export function rpcOpen(ws: RpcSocket, daemon: Daemon): void {
  ws.data.conn = daemon.connectLocal({
    send: (frame) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(frame));
      }
    },
  });
}

export function rpcMessage(ws: RpcSocket, msg: string | Buffer): void {
  if (typeof msg === "string") ws.data.conn?.dispatchText(msg);
}

export function rpcClose(ws: RpcSocket): void {
  // conn.close() is idempotent; fires the router's per-connection cleanups
  // (subscription fanouts) so a reloaded webview never leaks subscribers.
  ws.data.conn?.close();
  ws.data.conn = null;
}
