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
// Upstream merged our split-UTF-8 reader fix + BYTES API in 0.40.0 and our
// spawn-size option in 0.41.0 (sigmaSd/deno-pty#15), so we're on
// @sigma/pty-ffi proper. The pty stream stays raw bytes end-to-end — xterm
// decodes on the client — so codepoint splits and interior NULs are
// structurally a non-issue.
// The dylib stays VENDORED (vendor/libpty_arm64.dylib, byte-for-byte the
// upstream 0.42.0 release asset): a signed .app must never download binaries
// at runtime. Packaged: `--include vendor` (T-Gate 2).
// The version pin lives in the root deno.json imports map — an inline `jsr:`
// specifier would resolve fine but never reach `deno install`'s manifest
// scan, so the lock entry would depend on which files a command happened to
// check.
import { instantiate, libName, Pty } from "@sigma/pty-ffi/noinit";
// UMD bundles: named-export detection is unreliable under node-compat, so
// take the module object and destructure (the pattern deno actually loads).
import serializePkg from "@xterm/addon-serialize";
import type { Terminal as HeadlessTerminal } from "@xterm/headless";
import headlessPkg from "@xterm/headless";

const { Terminal } = headlessPkg;
const { SerializeAddon } = serializePkg;

const vendored = new URL(`../vendor/${libName()}`, import.meta.url);
await instantiate(
  (await Deno.stat(vendored).catch(() => null))
    ? vendored.pathname
    : `${Deno.cwd()}/vendor/${libName()}`, // --hmr: import.meta points at temp dir
);

const HIGH = 256 * 1024; // pause reading the pty above this many unacked bytes
const LOW = 64 * 1024; //  resume below this
const SCROLLBACK = 5000; // rows of history per session (matches the client)

interface PtySession {
  id: string;
  pty: Pty;
  term: HeadlessTerminal; // server-side mirror: scrollback + query answering
  snapshot: () => string;
  socket: WebSocket | null;
  outstanding: number; // true wire bytes sent-but-unacked (exact, not UTF-16 units)
}

const sessions = new Map<string, PtySession>();

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
      s.term.write(data);
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
      s.term.dispose();
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
  // Spawn-time size, passed straight to openpty so the shell's first prompt
  // renders at the real width — no 80x24 default to race against.
  const dim = (k: string) => {
    const n = Number(url.searchParams.get(k));
    return Number.isInteger(n) && n >= 2 && n <= 1000 ? n : null;
  };
  const cols = dim("cols");
  const rows = dim("rows");
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
          ...(cols !== null && rows !== null ? { size: { cols, rows } } : {}),
        });
      } catch {
        // cwd vanished / shell missing — refuse the attach, keep the record.
        socket.close(1011, "pty spawn failed");
        return;
      }
      const term = new Terminal({
        allowProposedApi: true, // required by the serialize addon
        scrollback: SCROLLBACK,
        cols: cols ?? 80,
        rows: rows ?? 24,
      });
      const serialize = new SerializeAddon();
      term.loadAddon(serialize);
      s = {
        id: name,
        pty,
        term,
        snapshot: () => serialize.serialize(),
        socket: null,
        outstanding: 0,
      };
      sessions.set(name, s);
      // Query answering while DETACHED (attached: the client's xterm
      // answers, and this stays silent to avoid double answers). onData
      // fires only for parser auto-responses here — nobody types into the
      // headless terminal.
      const session = s;
      term.onData((d) => {
        if (session.socket) return;
        try {
          session.pty.write(d);
        } catch {
          // pty gone; pump's finally cleans up
        }
      });
      pump(s);
    }
    if (s.socket) {
      // Single attached client; latest wins. A steady stream of these in
      // the dev log means two clients are FIGHTING for the session (each
      // kick triggers the other's reconnect) — look for a forgotten
      // window/tab with the same session open.
      console.log(`[pty] kicking previous client of session ${name}`);
      s.socket.close();
    }
    s.socket = socket;
    s.outstanding = 0; // snapshot isn't flow-controlled (bounded by SCROLLBACK rows)
    const replay = s.snapshot();
    if (replay) socket.send(new TextEncoder().encode(replay));
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
        // Keep the mirror's grid in lockstep so reflow + the next
        // serialize() reconstruct at the real dimensions.
        s.term.resize(m.cols, m.rows);
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
