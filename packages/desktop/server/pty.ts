// PTY sessions over loopback WebSocket — the agentmux/Deno-core pattern,
// validated in T-Gate 3 (50MB/s loopback, ACK backpressure bounded ~1.1MB).
//
// Model (t3code-style tmux-lite): the PTY belongs to the SESSION, not the
// socket — a dropped/reconnected client re-attaches the same live shell.
// One attached client at a time (latest wins); output keeps flowing into a
// server-side HEADLESS terminal while detached.
//
// The headless terminal (@xterm/headless) replaces the old raw-byte ring:
// every pty byte is parsed into it, and re-attach replays
// SerializeAddon.serialize() — a clean VT reconstruction of the screen +
// scrollback. Raw replay was a bug CLASS: the ring preserved terminal
// QUERIES a TUI once sent (DA1, XTVERSION, DECRQM…), the client's xterm
// re-answered them on parse, and with the TUI gone the shell ate the
// answers as keystrokes (`1;2c`, `>|xterm.js…` typed at the prompt).
// Serialize output contains no queries by construction — the headless
// parser consumed them. History is bounded in ROWS (scrollback option),
// not bytes, so `clear` really clears and reflow stays coherent.
//
// While detached the headless terminal also ANSWERS queries (onData →
// pty.write), so a TUI running unattended doesn't hang on DA1. While a
// client is attached its xterm answers instead — the gate prevents double
// answers.
//
// Client protocol (JSON): {t:"in",d} keystrokes · {t:"size",cols,rows} resize
// · {t:"ack",n} flow control (bytes consumed by xterm's write callback).
// Server→client frames are raw PTY bytes; first frame after attach = the
// serialized snapshot.
//
// Runtime deltas vs the deno predecessor (git history of this file):
//  - @sigma/pty-ffi + vendored dylib + hand-written read pump → Bun.Terminal
//    INLINE options (bun #33237: the existing-instance form skips
//    setsid/TIOCSCTTY and breaks ^C — never use it). Spawn-size rides in the
//    options, so there is no 80x24 race to fix.
//  - Push-model data callback replaces the pull pump. Fidelity gap: the pump
//    PAUSED reads above HIGH unacked bytes; Bun.Terminal has no read-pause,
//    so a slow client buffers in the ws instead. Loopback + an acking client
//    makes this theoretical; log if it ever trips.
//  - Plain named imports: bun's ESM/CJS interop detects named exports on the
//    UMD bundles (deno's node-compat couldn't — it needed default-import +
//    destructure). Note @xterm/headless 6.1.0-beta.288 ships a broken
//    `module` field (lib/xterm.mjs doesn't exist); bun silently falls back
//    to the CJS `main`.
import { SerializeAddon } from "@xterm/addon-serialize";
import { type Terminal as HeadlessTerminal, Terminal } from "@xterm/headless";
import type { Server, ServerWebSocket } from "bun";

const HIGH = 256 * 1024; // log threshold for unacked bytes (no read-pause in push model)
const SCROLLBACK = 5000; // rows of history per session (matches the client)

export type PtyWsData = {
  kind: "pty";
  name: string;
  cwd: string | null;
  cols: number | null;
  rows: number | null;
};

type PtySocket = ServerWebSocket<PtyWsData>;

interface PtySession {
  id: string;
  proc: Bun.Subprocess;
  pterm: Bun.Terminal;
  term: HeadlessTerminal; // server-side mirror: scrollback + query answering
  snapshot: () => string;
  socket: PtySocket | null;
  outstanding: number;
  highWarned: boolean;
}

const sessions = new Map<string, PtySession>();

export function ptyUpgrade(req: Request, server: Server): Response | undefined {
  const url = new URL(req.url);
  const name = url.searchParams.get("session") ?? "default";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    return new Response("bad session name", { status: 400 });
  }
  // Client owns the session→cwd mapping; only matters on FIRST attach.
  const cwd = url.searchParams.get("cwd");
  if (cwd !== null && !cwd.startsWith("/")) {
    return new Response("cwd must be absolute", { status: 400 });
  }
  const dim = (k: string) => {
    const n = Number(url.searchParams.get(k));
    return Number.isInteger(n) && n >= 2 && n <= 1000 ? n : null;
  };
  const data: PtyWsData = {
    kind: "pty",
    name,
    cwd,
    cols: dim("cols"),
    rows: dim("rows"),
  };
  return server.upgrade(req, { data })
    ? undefined
    : new Response("upgrade failed", { status: 400 });
}

export function ptyOpen(ws: PtySocket): void {
  const { name, cwd, cols, rows } = ws.data;
  let s = sessions.get(name);
  if (!s) {
    const term = new Terminal({
      allowProposedApi: true, // required by the serialize addon
      scrollback: SCROLLBACK,
      cols: cols ?? 80,
      rows: rows ?? 24,
    });
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);

    // Session object exists before spawn so the terminal callbacks can
    // close over it.
    const session: PtySession = {
      id: name,
      proc: null as unknown as Bun.Subprocess,
      pterm: null as unknown as Bun.Terminal,
      term,
      snapshot: () => serialize.serialize(),
      socket: null,
      outstanding: 0,
      highWarned: false,
    };

    let proc: Bun.Subprocess;
    try {
      proc = Bun.spawn([process.env.SHELL ?? "/bin/zsh", "-l"], {
        ...(cwd ? { cwd } : {}),
        env: {
          // Finder-launched apps get a bare LaunchServices env; LANG is
          // a fallback, TERM is forced — the child talks to xterm.js.
          LANG: "en_US.UTF-8",
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
        terminal: {
          cols: cols ?? 80,
          rows: rows ?? 24,
          data(_t, chunk) {
            session.term.write(chunk);
            const sock = session.socket;
            if (sock) {
              session.outstanding += chunk.byteLength;
              if (session.outstanding > HIGH && !session.highWarned) {
                session.highWarned = true;
                console.warn(
                  `[pty] session ${name}: client ${session.outstanding} bytes behind (no read-pause in Bun.Terminal push model)`,
                );
              }
              sock.send(chunk);
            }
          },
          exit() {
            // Shell exited (or pty died): drop the entry so the next
            // attach spawns a fresh shell instead of adopting a corpse.
            if (sessions.get(name) === session) {
              sessions.delete(name);
              session.socket?.close();
              session.term.dispose();
            }
          },
        },
      });
    } catch {
      // cwd vanished / shell missing — refuse the attach.
      term.dispose();
      ws.close(1011, "pty spawn failed");
      return;
    }
    session.proc = proc;
    session.pterm = proc.terminal!;
    // Query answering while DETACHED only (attached: client xterm answers).
    term.onData((d: string) => {
      if (session.socket) return;
      try {
        session.pterm.write(d);
      } catch {
        // pty gone; exit callback cleans up
      }
    });
    s = session;
    sessions.set(name, s);
  }
  if (s.socket) {
    // Single attached client; latest wins. A steady stream of these means
    // two clients are FIGHTING for the session.
    console.log(`[pty] kicking previous client of session ${name}`);
    s.socket.close();
  }
  s.socket = ws;
  s.outstanding = 0; // snapshot isn't flow-controlled (bounded by SCROLLBACK rows)
  s.highWarned = false;
  const replay = s.snapshot();
  if (replay) ws.send(new TextEncoder().encode(replay));
}

export function ptyMessage(ws: PtySocket, msg: string | Buffer): void {
  const s = sessions.get(ws.data.name);
  if (!s) return;
  try {
    const m = JSON.parse(typeof msg === "string" ? msg : msg.toString());
    if (m.t === "in") {
      s.pterm.write(m.d);
    } else if (m.t === "size") {
      s.pterm.resize(m.cols, m.rows);
      // Keep the mirror's grid in lockstep so reflow + the next
      // serialize() reconstruct at the real dimensions.
      s.term.resize(m.cols, m.rows);
    } else if (m.t === "ack") {
      s.outstanding = Math.max(0, s.outstanding - m.n);
    }
  } catch {
    // ignore malformed frame
  }
}

export function ptyClose(ws: PtySocket): void {
  const s = sessions.get(ws.data.name);
  if (s && s.socket === ws) s.socket = null; // pty survives for re-attach
}
