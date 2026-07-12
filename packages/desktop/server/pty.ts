// PTY sessions over loopback WebSocket — the agentmux/Deno-core pattern,
// validated in T-Gate 3 (50MB/s loopback, ACK backpressure bounded ~1.1MB).
//
// Model (t3code-style tmux-lite): the PTY belongs to the SESSION, not the
// socket — a dropped/reconnected client re-attaches the same live shell and
// gets the bounded scrollback ring replayed. One attached client at a time
// (latest wins); output keeps accumulating into the ring while detached.
//
// Client protocol (JSON): {t:"in",d} keystrokes · {t:"size",cols,rows} resize
// · {t:"ack",n} flow control (bytes consumed by xterm's write callback).
// Server→client frames are raw PTY text; first frame after attach = ring replay.
//
// Upstream merged our split-UTF-8 reader fix + BYTES API in 0.40.0, so we're
// back on @sigma/pty-ffi proper (the @yyq fork is archived). The pty stream
// stays raw bytes end-to-end — xterm decodes on the client — so codepoint
// splits and interior NULs are structurally a non-issue.
// The dylib stays VENDORED (vendor/libpty_arm64.dylib, byte-for-byte the
// upstream 0.40.0 release asset): a signed .app must never download binaries
// at runtime. Packaged: `--include vendor` (T-Gate 2).
import { instantiate, libName, Pty } from "jsr:@sigma/pty-ffi@0.40.0/noinit";

const vendored = new URL(`../vendor/${libName()}`, import.meta.url);
await instantiate(
  (await Deno.stat(vendored).catch(() => null))
    ? vendored.pathname
    : `${Deno.cwd()}/vendor/${libName()}`, // --hmr: import.meta points at temp dir
);

const HIGH = 256 * 1024; // pause reading the pty above this many unacked bytes
const LOW = 64 * 1024; //  resume below this
const RING_MAX = 512 * 1024; // scrollback replay budget per session

/** Kill the shell + detach the client (session delete). */
export function killPty(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  s.socket?.close();
  try {
    s.pty.close();
  } catch {
    // already dead
  }
}

interface PtySession {
  id: string;
  pty: Pty;
  ring: Uint8Array[];
  ringBytes: number;
  socket: WebSocket | null;
  outstanding: number; // true wire bytes sent-but-unacked (exact, not UTF-16 units)
}

const sessions = new Map<string, PtySession>();

function pushRing(s: PtySession, data: Uint8Array) {
  s.ring.push(data);
  s.ringBytes += data.byteLength;
  while (s.ringBytes > RING_MAX && s.ring.length > 1) {
    s.ringBytes -= s.ring[0].byteLength;
    s.ring.shift();
  }
}

function concatRing(s: PtySession): Uint8Array {
  const out = new Uint8Array(s.ringBytes);
  let off = 0;
  for (const chunk of s.ring) {
    out.set(chunk, off);
    off += chunk.byteLength;
  }
  return out;
}

// Read loop: RAW read() pump, NOT pty.readable — the library's stream sleeps
// pollingInterval per CHUNK, so throughput collapses under flood (verified:
// raw pump moves the same payload at full speed vs ~50% loss + stalls).
// Sleeps only when idle. Pauses while the attached client is behind (ACK flow
// control → kernel pty buffer fills → producer's write() blocks → the flood
// self-throttles end-to-end).
async function pump(s: PtySession) {
  try {
    while (true) {
      if (s.outstanding > HIGH) {
        while (s.outstanding > LOW && s.socket) {
          await new Promise((r) => setTimeout(r, 4));
        }
      }
      const { data, done } = s.pty.readBytes();
      if (done) break;
      if (!data.byteLength) {
        await new Promise((r) => setTimeout(r, 8));
        continue;
      }
      pushRing(s, data);
      if (s.socket?.readyState === WebSocket.OPEN) {
        s.outstanding += data.byteLength;
        s.socket.send(data);
      }
      // Cooperative yield: a sync read burst must not starve the event loop.
      await new Promise((r) => setTimeout(r, 0));
    }
  } catch {
    // pty torn down
  } finally {
    // Shell exited (or pty died): drop the entry so the next attach spawns a
    // fresh shell at the session's cwd instead of adopting a corpse.
    if (sessions.get(s.id) === s) {
      sessions.delete(s.id);
      s.socket?.close();
    }
  }
}

export function handlePty(req: Request): Response {
  const url = new URL(req.url);
  const name = url.searchParams.get("session") ?? "default";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    return new Response("bad session name", { status: 400 });
  }
  // The client owns the session→cwd mapping (sessions-collection row) and
  // sends it along; it only matters on the FIRST attach (shell spawn dir) —
  // a live shell keeps its own cwd. Same trust boundary as before: this is
  // a loopback server whose purpose is a shell for the local user.
  const cwd = url.searchParams.get("cwd");
  if (cwd !== null && !cwd.startsWith("/")) {
    return new Response("cwd must be absolute", { status: 400 });
  }
  const { socket, response } = Deno.upgradeWebSocket(req);

  socket.onopen = () => {
    let s = sessions.get(name);
    if (!s) {
      let pty: Pty;
      try {
        pty = new Pty(Deno.env.get("SHELL") ?? "/bin/zsh", {
          args: ["-l"],
          env: {
            // Finder-launched apps get a bare LaunchServices env: no LANG
            // (shells fall back to the C locale) and no TERM (ZLE has no
            // terminfo and garbles the prompt — a literal `?` before it).
            // LANG is a fallback only; TERM is forced because the terminal
            // the child actually talks to is xterm.js, not whatever
            // launched this process.
            LANG: "en_US.UTF-8",
            ...Deno.env.toObject(),
            TERM: "xterm-256color",
            COLORTERM: "truecolor",
          },
          ...(cwd ? { cwd } : {}),
        });
      } catch {
        // cwd vanished / shell missing — refuse the attach, keep the record.
        socket.close(1011, "pty spawn failed");
        return;
      }
      s = {
        id: name,
        pty,
        ring: [],
        ringBytes: 0,
        socket: null,
        outstanding: 0,
      };
      sessions.set(name, s);
      pump(s);
    }
    s.socket?.close(); // single attached client; latest wins
    s.socket = socket;
    s.outstanding = 0; // replay isn't flow-controlled (bounded by RING_MAX)
    if (s.ring.length) socket.send(concatRing(s));
  };

  socket.onmessage = (ev) => {
    const s = sessions.get(name);
    if (!s) return;
    try {
      const m = JSON.parse(ev.data);
      if (m.t === "in") {
        s.pty.write(m.d);
      } else if (m.t === "size") {
        s.pty.resize({ rows: m.rows, cols: m.cols });
      } else if (m.t === "ack") {
        s.outstanding = Math.max(0, s.outstanding - m.n);
      }
    } catch {
      // ignore malformed frame
    }
  };

  const detach = () => {
    const s = sessions.get(name);
    if (s && s.socket === socket) s.socket = null; // pty survives for re-attach
  };
  socket.onclose = detach;
  socket.onerror = detach;

  return response;
}
