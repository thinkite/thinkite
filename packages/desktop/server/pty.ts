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
// Runtime deltas vs the electrobun predecessor (git history of this file):
//  - Bun.Terminal → @lydell/node-pty (prebuilt N-API — loads in Electron's
//    main-process Node without an electron-rebuild step). Same push-model
//    data callback, so the no-read-pause fidelity gap carries over: a slow
//    client buffers in the ws instead of pausing the pty read. Loopback +
//    an acking client keeps this theoretical; the HIGH log guard stays.
//  - Bun.serve's handler-per-server websocket API → `ws` package per-socket
//    listeners. index.ts routes the HTTP upgrade; this module owns the
//    socket from attach onward.
//  - UMD bundles: default-import + destructure (Node's CJS named-export
//    lexer can miss these — the same class of issue deno had; bun's custom
//    interop was the outlier that allowed plain named imports).
import { type IPty, spawn } from "@lydell/node-pty";
import serializePkg from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import headlessPkg from "@xterm/headless";
import type { WebSocket } from "ws";

const { SerializeAddon } = serializePkg;
const { Terminal } = headlessPkg;

const HIGH = 256 * 1024; // log threshold for unacked bytes (no read-pause in push model)
const SCROLLBACK = 5000; // rows of history per session (matches the client)

export interface PtyParams {
  name: string;
  cwd: string | null;
  cols: number | null;
  rows: number | null;
}

interface PtySession {
  id: string;
  proc: IPty;
  term: HeadlessTerminal; // server-side mirror: scrollback + query answering
  snapshot: () => string;
  socket: WebSocket | null;
  outstanding: number;
  highWarned: boolean;
}

const sessions = new Map<string, PtySession>();

/** Validate /pty query params BEFORE the ws upgrade. Returns params, or an
 *  error string the caller turns into a 400. */
export function ptyParams(url: URL): PtyParams | string {
  const name = url.searchParams.get("session") ?? "default";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return "bad session name";
  // Client owns the session→cwd mapping; only matters on FIRST attach.
  const cwd = url.searchParams.get("cwd");
  if (cwd !== null && !cwd.startsWith("/")) return "cwd must be absolute";
  const dim = (k: string) => {
    const n = Number(url.searchParams.get(k));
    return Number.isInteger(n) && n >= 2 && n <= 1000 ? n : null;
  };
  return { name, cwd, cols: dim("cols"), rows: dim("rows") };
}

export function attachPty(
  ws: WebSocket,
  { name, cwd, cols, rows }: PtyParams,
): void {
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

    let proc: IPty;
    try {
      proc = spawn(process.env.SHELL ?? "/bin/zsh", ["-l"], {
        name: "xterm-256color",
        cols: cols ?? 80,
        rows: rows ?? 24,
        ...(cwd ? { cwd } : {}),
        env: {
          // Finder-launched apps get a bare LaunchServices env; LANG is
          // a fallback, TERM is forced — the child talks to xterm.js.
          LANG: "en_US.UTF-8",
          ...process.env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
      });
    } catch {
      // cwd vanished / shell missing — refuse the attach.
      term.dispose();
      ws.close(1011, "pty spawn failed");
      return;
    }

    const session: PtySession = {
      id: name,
      proc,
      term,
      snapshot: () => serialize.serialize(),
      socket: null,
      outstanding: 0,
      highWarned: false,
    };

    proc.onData((chunk) => {
      session.term.write(chunk);
      const sock = session.socket;
      if (sock) {
        const bytes = Buffer.from(chunk, "utf8");
        session.outstanding += bytes.byteLength;
        if (session.outstanding > HIGH && !session.highWarned) {
          session.highWarned = true;
          console.warn(
            `[pty] session ${name}: client ${session.outstanding} bytes behind (no read-pause in the push model)`,
          );
        }
        sock.send(bytes);
      }
    });
    proc.onExit(() => {
      // Shell exited (or pty died): drop the entry so the next attach
      // spawns a fresh shell instead of adopting a corpse.
      if (sessions.get(name) === session) {
        sessions.delete(name);
        session.socket?.close();
        session.term.dispose();
      }
    });
    // Query answering while DETACHED only (attached: client xterm answers).
    term.onData((d: string) => {
      if (session.socket) return;
      try {
        session.proc.write(d);
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

  const session = s;
  ws.on("message", (msg) => {
    try {
      const m = JSON.parse(msg.toString());
      if (m.t === "in") {
        session.proc.write(m.d);
      } else if (m.t === "size") {
        session.proc.resize(m.cols, m.rows);
        // Keep the mirror's grid in lockstep so reflow + the next
        // serialize() reconstruct at the real dimensions.
        session.term.resize(m.cols, m.rows);
      } else if (m.t === "ack") {
        session.outstanding = Math.max(0, session.outstanding - m.n);
      }
    } catch {
      // ignore malformed frame
    }
  });
  ws.on("close", () => {
    if (session.socket === ws) session.socket = null; // pty survives for re-attach
  });

  const replay = session.snapshot();
  if (replay) ws.send(Buffer.from(replay, "utf8"));
}
