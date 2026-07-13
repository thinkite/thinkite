import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import type { ITheme } from "@xterm/xterm";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

// ACK flow control: report bytes only after xterm has actually consumed them
// (write callback), so a flood can't balloon xterm's internal parse queue.
// Server pauses reading the pty past its high-water mark (server/pty.ts).
const ACK_EVERY = 32 * 1024;

// System-scheme-following themes (the rest of the app follows via astryx's
// CSS `light-dark()` tokens; the terminal needs JS palettes). Swapping
// `term.options.theme` at runtime also drives xterm's colorSchemeQuery
// extension (on by default): it re-derives dark/light from theme luminance
// and notifies programs that enabled mode 2031 (claude's TUI does) with
// `CSI ?997;n` — so a running TUI re-skins itself live.
// Dark keeps xterm's stock ANSI palette (tuned for dark backgrounds); light
// needs a full ANSI set or default yellow/white output is unreadable
// (VS Code Light+ terminal palette).
const DARK_THEME: ITheme = { background: "#000000" };
const LIGHT_THEME: ITheme = {
  background: "#ffffff",
  foreground: "#333333",
  cursor: "#333333",
  selectionBackground: "#b4d5fe",
  black: "#000000",
  red: "#cd3131",
  green: "#00bc00",
  yellow: "#949800",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#b5ba00",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#a5a5a5",
};

export function TerminalPane({
  sessionId,
  cwd,
}: {
  sessionId: string;
  cwd: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const term = new XTerm({
      allowProposedApi: true, // required by unicode-graphemes
      fontFamily: "Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: scheme.matches ? DARK_THEME : LIGHT_THEME,
    });
    const applyScheme = () => {
      const theme = scheme.matches ? DARK_THEME : LIGHT_THEME;
      term.options.theme = theme;
      // The host div shows through around the cell grid (padding, partial
      // rows) — keep it in lockstep with the terminal background.
      host.style.backgroundColor = theme.background ?? "#000000";
    };
    applyScheme();
    scheme.addEventListener("change", applyScheme);
    term.loadAddon(new UnicodeGraphemesAddon());
    try {
      const versions = term.unicode.versions ?? [];
      const graphemes =
        versions.find((v) => /graph|1[5-9]/.test(String(v))) ?? versions.at(-1);
      if (graphemes) term.unicode.activeVersion = graphemes;
    } catch {
      // width falls back to xterm defaults
    }
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    let ws: WebSocket | null = null;
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let acked = 0;

    const sendSize = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ t: "size", cols: term.cols, rows: term.rows }),
        );
      }
    };

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      // Relative host: same-origin in packaged mode, Vite proxy in dev.
      // cwd + size ride along for the FIRST attach: cwd is the shell spawn
      // dir (the client owns the session→cwd mapping via the sessions
      // collection), and cols/rows are the pty's SPAWN size — the server
      // opens the pty at these dimensions (pty-ffi ≥0.41), so the shell's
      // first prompt renders at the real width instead of a default 80x24
      // that would reflow into stray blank lines. Both are ignored when
      // re-attaching a live shell. connect() only runs after fit() (lazy
      // attach), so term.cols/rows are the real dimensions here.
      ws = new WebSocket(
        `${proto}://${location.host}/pty?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(cwd)}&cols=${term.cols}&rows=${term.rows}`,
      );
      // Server sends raw PTY BYTES (binary frames); xterm's own streaming
      // UTF-8 decoder handles codepoints split across chunks. ACK counts true
      // wire bytes, so the server's flow-control watermarks are exact.
      // The first frame after attach is the serialized snapshot — clean VT
      // with no device queries (the server's headless terminal consumed
      // them), so it's safe to parse like any live output.
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        // The snapshot about to arrive is the FULL authoritative state
        // (screen + scrollback). Start from a clean terminal so a re-attach
        // replaces content instead of appending — otherwise any connection
        // flap (a stale tab fighting for the session, a proxy drop) stacks
        // one whole screen per reconnect.
        term.reset();
        sendSize();
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") return; // protocol is binary-only today
        const data = new Uint8Array(ev.data as ArrayBuffer);
        term.write(data, () => {
          acked += data.byteLength;
          if (acked >= ACK_EVERY) {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ t: "ack", n: acked }));
            }
            acked = 0;
          }
        });
      };
      ws.onclose = () => {
        // Server keeps the pty + scrollback; re-attach shortly.
        if (!disposed) retry = setTimeout(connect, 800);
      };
    };

    // The route mounts this component only once its panel has been OPENED
    // (t3code's drawer pattern) — that structural gate is the lazy attach:
    // an unopened terminal never connects, so no shell spawns and no prompt
    // renders at a wrong hidden-measure width. By mount time the host is
    // laid out; the only remaining gate is fonts (WKWebView measures cell
    // size wrong before they load).
    const visible = () => host.clientWidth >= 80 && host.clientHeight >= 40;
    document.fonts.ready.finally(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        // not measurable (already hidden again); attach at xterm defaults —
        // the size message after the observer's refit corrects the pty.
      }
      connect();
    });

    term.onData((d) => {
      // Keystrokes AND xterm's own query auto-answers (DA1 etc) — while
      // attached, this side answers; detached, the server's headless
      // terminal takes over.
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "in", d }));
      }
    });
    term.onResize(sendSize);

    // Debounced (trailing) refit: a panel drag fires the observer per frame,
    // and fitting every frame means a pty resize + SIGWINCH + zle prompt
    // redraw per frame — one drag gesture stacked dozens of stale prompt
    // lines (each with zsh's reverse-video % partial-line mark). Settle
    // first, then resize ONCE, and only when the cell grid actually changed
    // (height deltas within the same row count are free).
    let fitTimer: ReturnType<typeof setTimeout> | undefined;
    const refit = () => {
      if (disposed || !visible()) return;
      try {
        const dims = fit.proposeDimensions();
        if (dims && (dims.cols !== term.cols || dims.rows !== term.rows)) {
          fit.fit();
        }
      } catch {
        // host hidden
      }
    };
    const ro = new ResizeObserver(() => {
      // Skip while effectively invisible (panel closed after first open —
      // we stay mounted to keep the buffer) — fitting then would clamp cols
      // to ~2 and reflow the scrollback into confetti; fires again on reopen.
      if (!visible()) return;
      clearTimeout(fitTimer);
      fitTimer = setTimeout(refit, 150);
    });
    ro.observe(host);

    return () => {
      disposed = true;
      clearTimeout(retry);
      clearTimeout(fitTimer);
      ro.disconnect();
      scheme.removeEventListener("change", applyScheme);
      ws?.close();
      term.dispose();
    };
  }, [sessionId, cwd]);

  return <div ref={hostRef} className="h-full w-full" />;
}
