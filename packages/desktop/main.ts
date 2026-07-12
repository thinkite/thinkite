// Deno Desktop entry. Serves the Vite-built SPA from dist/ (the auto-window
// navigates to Deno.serve) — same shape as deno's own Vite framework-detection
// entrypoint, kept explicit because P1+ mounts our own routes (PTY WebSocket,
// search, git) on this same server, which detection's synthetic entry can't do.
// npm deps resolve through deno.json's imports map (none-mode, global cache);
// the daemon workspace lib is mapped to its built dist. (A historical note
// warned against npm imports here — denoland/deno#35544 — long since fine:
// transcript.ts pulled the agent SDK into this graph in P2.)
//
// Dev:   pnpm build && deno desktop --hmr -A main.ts
//        (or `pnpm dev:web` + SIDECODE_DESKTOP_VITE=http://localhost:5183
//         deno desktop --hmr -A main.ts   for full React HMR)
// Pack:  vite build first, then `deno desktop --include dist -o Sidecode.app main.ts`
//        + entitlements re-sign (sidecode#23) via the packaging script.
import { serveDir } from "jsr:@std/http/file-server";
import {
  type Daemon,
  readActiveDaemonLock,
  resolveSidecodeHome,
  start as startDaemon,
} from "@sidecodeapp/daemon";
import { handleDiff } from "./server/diff.ts";
import { handlePty, setSessionHooks } from "./server/pty.ts";
import { handleRpc } from "./server/rpc.ts";
import { getSessionCwd, handleSessionsApi } from "./server/sessions.ts";
import { handleTranscript } from "./server/transcript.ts";

// PTY ↔ session-store wiring (kept out of the modules to avoid a two-way
// import between two top-level-awaiting modules). Sessions are the daemon's
// (read-only mirror), so PTY activity no longer touches any store — daemon
// metadata records Claude activity, not shell keystrokes.
setSessionHooks({
  getCwd: getSessionCwd,
  onActivity: () => {},
});

// Two possible dist/ roots:
//  - packaged: `--include dist` embeds it next to the compiled entry (import.meta)
//  - dev (--hmr): import.meta points at a temp compile dir, so fall back to cwd
//    (reads the live dist from disk — `vite build --watch` output shows up on
//    plain reload, no deno restart / re-embed needed)
const fsRoot = await (async () => {
  const roots = [`${import.meta.dirname}/dist`, `${Deno.cwd()}/dist`];
  for (const root of roots) {
    try {
      await Deno.stat(`${root}/index.html`);
      return root;
    } catch {
      // try next root
    }
  }
  console.error("dist/index.html not found — run `pnpm build` first");
  return roots[1];
})();

const viteDev = Deno.env.get("SIDECODE_DESKTOP_VITE");

// In-process daemon (D2): this process IS the sidecode daemon — same
// identity, same ~/.sidecode home, same signaling presence the iOS app pairs
// against. `start()` only writes the liveness lock, so the host checks it
// first: if another daemon owns the home (e.g. the menubar app), the GUI
// keeps working in local-only mode (PTY/transcript/diff read paths don't
// need the daemon) rather than fighting over signaling with a twin identity.
let daemon: Daemon | null = null;
{
  const home = resolveSidecodeHome(); // ensures the dir exists
  const lock = readActiveDaemonLock(home);
  if (lock) {
    console.warn(
      `[desktop] another daemon owns ${home} (pid ${lock.pid}) — starting GUI without in-process daemon`,
    );
  } else {
    // Dev: spawn the repo's pnpm-installed claude binary (same seam
    // run-query.ts forwards). cwd-relative like fsRoot — under --hmr,
    // import.meta points at a temp compile dir. Packaged builds replace
    // this with the embed+extract path in the packaging slice; undefined
    // lets the SDK try its own resolution as a last resort.
    const devClaude =
      `${Deno.cwd()}/../../node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`;
    const claudeExecutablePath = (await Deno.stat(devClaude).catch(() => null))
      ? devClaude
      : undefined;
    daemon = await startDaemon({ claudeExecutablePath });
    console.log(
      `[desktop] daemon up — fingerprint ${daemon.fingerprint}, pairedClients ${daemon.pairedClientCount()}`,
    );
  }
}

// One shutdown path for every exit trigger (window close, SIGINT/SIGTERM):
// drain the daemon (WebRTC peers, claude subprocesses, JSONL writes) before
// the process dies. Idempotent — close + signal can both fire.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await daemon?.stop();
  } catch (e) {
    console.error("[desktop] daemon stop failed:", e);
  }
  Deno.exit(0);
}
Deno.addSignalListener("SIGINT", () => void shutdown());
Deno.addSignalListener("SIGTERM", () => void shutdown());

// NOTE: deno desktop's runtime pre-allocates the serve port and IGNORES the
// `port` option (publishes the real one via DENO_SERVE_ADDRESS) — fixed ports
// are impossible here. The Vite proxy learns our real port via env instead.
Deno.serve({ port: 0, onListen() {} }, async (req) => {
  const url = new URL(req.url);
  if (
    url.pathname === "/pty" &&
    (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket"
  ) {
    return handlePty(req);
  }
  if (
    url.pathname === "/rpc" &&
    (req.headers.get("upgrade") ?? "").toLowerCase() === "websocket"
  ) {
    return handleRpc(req, daemon);
  }
  if (url.pathname === "/api/daemon/status") {
    return Response.json(
      daemon
        ? {
            running: true,
            fingerprint: daemon.fingerprint,
            pairedClients: daemon.pairedClientCount(),
            authenticatedPeers: daemon.authenticatedPeerCount(),
          }
        : { running: false },
    );
  }
  if (url.pathname === "/api/diff") {
    return await handleDiff(req);
  }
  if (url.pathname === "/api/transcript") {
    return await handleTranscript(req);
  }
  if (url.pathname.startsWith("/api/")) {
    return await handleSessionsApi(req);
  }
  const res = await serveDir(req, { fsRoot, quiet: true });
  // SPA fallback: only for HTML navigations, so missing assets/API paths still 404.
  if (
    res.status === 404 &&
    req.method === "GET" &&
    (req.headers.get("accept") ?? "").includes("text/html")
  ) {
    const index = new Request(new URL("/index.html", req.url), {
      headers: req.headers,
    });
    return await serveDir(index, { fsRoot, quiet: true });
  }
  return res;
});

// Headless guard: `deno run` (no desktop runtime) still boots the server +
// daemon — the harness the D2 checks and future integration tests drive.
const win = "BrowserWindow" in Deno
  ? new Deno.BrowserWindow({
      title: "Sidecode",
      width: 1200,
      height: 800,
    })
  : null;
win?.addEventListener("close", () => void shutdown());
if (!win) {
  console.log("[desktop] no desktop runtime — headless mode (server + daemon only)");
}

// Full React HMR loop: spawn the Vite dev server ourselves (what deno's
// framework-dev mode intends but hasn't wired up) and point the window at it.
// Frontend edits → Vite ws HMR; main.ts HANDLER-BODY edits → V8 hot-swap +
// auto page reload. Caveat (rt/hmr.rs): TOP-LEVEL main.ts changes can't
// hot-swap ("blocked by top-level ES module change") — restart for those.
if (viteDev && win) {
  const alive = async () => {
    try {
      await fetch(viteDev, { method: "HEAD" });
      return true;
    } catch {
      return false;
    }
  };
  // Reuse an already-running dev server (e.g. a separate `pnpm dev:web`);
  // otherwise spawn one and tie its lifetime to the window. The general
  // close→shutdown listener (above) handles daemon drain + exit; this one
  // only reaps the vite child first.
  if (!(await alive())) {
    // Tell Vite's proxy where our (runtime-chosen) server actually is.
    const serveAddr = Deno.env.get("DENO_SERVE_ADDRESS") ?? "";
    const ptyTarget = `http://127.0.0.1:${serveAddr.split(":").pop()}`;
    const vite = new Deno.Command("pnpm", {
      args: ["dev:web"],
      stdout: "inherit",
      stderr: "inherit",
      env: { ...Deno.env.toObject(), SIDECODE_PTY_TARGET: ptyTarget },
    }).spawn();
    win.addEventListener("close", () => {
      try {
        vite.kill();
      } catch {
        // already gone
      }
    });
    for (let i = 0; i < 100 && !(await alive()); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  win.navigate(viteDev);
}
