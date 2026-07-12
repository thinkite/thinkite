import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal as XTerm } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";

// ACK flow control: report bytes only after xterm has actually consumed them
// (write callback), so a flood can't balloon xterm's internal parse queue.
// Server pauses reading the pty past its high-water mark (server/pty.ts).
const ACK_EVERY = 32 * 1024;

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

    const term = new XTerm({
      allowProposedApi: true, // required by unicode-graphemes
      fontFamily: "Menlo, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#000000" },
    });
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
      // collection), and cols/rows let the server resize the fresh pty
      // BEFORE the shell prints its first prompt — pty-ffi spawns at a
      // hardcoded 80x24, and a prompt printed at that width reflows into
      // stray blank lines once the real size lands. Both are ignored when
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
      ws?.close();
      term.dispose();
    };
  }, [sessionId, cwd]);

  return <div ref={hostRef} className="h-full w-full bg-black" />;
}
