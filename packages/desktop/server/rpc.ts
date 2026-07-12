// WebSocket bridge from the renderer to the in-process daemon's command
// router — the local twin of the iOS WebRTC transport. Dumb by design: the
// daemon's LocalConnection owns frame parsing, validation, and error replies
// (invalid input is answered in-band, never thrown); this module only moves
// text and ties connection lifetime to socket lifetime.
//
// One LocalConnection per socket. Closing the socket fires the router's
// per-connection cleanups (subscription fanouts), so a reloaded webview
// never leaks subscribers.
import type { Daemon } from "@sidecodeapp/daemon";

export function handleRpc(req: Request, daemon: Daemon | null): Response {
  if (daemon === null) {
    // Another daemon owns ~/.sidecode (or startup failed) — the GUI shows
    // its daemon-offline state off this instead of a dead socket.
    return new Response("daemon not running in this process", { status: 503 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);
  const conn = daemon.connectLocal({
    send: (frame) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(frame));
      }
    },
  });
  socket.addEventListener("message", (ev) => {
    if (typeof ev.data === "string") conn.dispatchText(ev.data);
  });
  // close always follows error, but conn.close() is idempotent — wiring
  // both keeps teardown independent of that ordering detail.
  socket.addEventListener("close", () => conn.close());
  socket.addEventListener("error", () => conn.close());
  return response;
}
