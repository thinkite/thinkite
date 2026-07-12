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
      // cwd rides along for the FIRST attach (shell spawn dir — the client
      // owns the session→cwd mapping via the sessions collection); the
      // server ignores it when re-attaching a live shell.
      ws = new WebSocket(
        `${proto}://${location.host}/pty?session=${encodeURIComponent(sessionId)}&cwd=${encodeURIComponent(cwd)}`,
      );
      // Server sends raw PTY BYTES (binary frames); xterm's own streaming
      // UTF-8 decoder handles codepoints split across chunks. ACK counts true
      // wire bytes, so the server's flow-control watermarks are exact.
      ws.binaryType = "arraybuffer";
      ws.onopen = () => sendSize();
      ws.onmessage = (ev) => {
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

    // Fit only after fonts are ready (WKWebView measures wrong before), then attach.
    document.fonts.ready.finally(() => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        // host not measurable yet; ResizeObserver will retry
      }
      connect();
    });

    term.onData((d) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ t: "in", d }));
      }
    });
    term.onResize(sendSize);

    const ro = new ResizeObserver(() => {
      // Skip while effectively invisible (tool panel closed zeroes our width)
      // — fitting then would clamp cols to ~2 and make the server reflow the
      // whole scrollback into confetti; the observer fires again on reopen.
      if (host.clientWidth < 80 || host.clientHeight < 40) return;
      try {
        fit.fit();
      } catch {
        // host hidden
      }
    });
    ro.observe(host);

    return () => {
      disposed = true;
      clearTimeout(retry);
      ro.disconnect();
      ws?.close();
      term.dispose();
    };
  }, [sessionId, cwd]);

  return <div ref={hostRef} className="h-full w-full bg-black" />;
}
