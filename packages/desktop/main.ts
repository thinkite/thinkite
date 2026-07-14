// Deno Desktop entry. Serves the Vite-built SPA from dist/ (the auto-window
// navigates to Deno.serve) — same shape as deno's own Vite framework-detection
// entrypoint, kept explicit because P1+ mounts our own routes (PTY WebSocket,
// search, git) on this same server, which detection's synthetic entry can't do.
// npm deps resolve through deno.json's imports map (none-mode, global cache);
// the daemon workspace lib is mapped to its built dist. (A historical note
// warned against npm imports here — denoland/deno#35544 — long since fine.)
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
import { handlePty } from "./server/pty.ts";
import { handleRpc } from "./server/rpc.ts";

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
// keeps working in local-only mode (PTY/diff paths don't need the daemon;
// sessions + transcripts do) rather than fighting over signaling with a
// twin identity.
let daemon: Daemon | null = null;
{
  const home = resolveSidecodeHome(); // ensures the dir exists
  const lock = readActiveDaemonLock(home);
  if (lock) {
    console.warn(
      `[desktop] another daemon owns ${home} (pid ${lock.pid}) — starting GUI without in-process daemon`,
    );
  } else {
    // Dev: spawn the SDK's platform-package claude binary (same seam
    // run-query.ts forwards). cwd-relative like fsRoot — under --hmr,
    // import.meta points at a temp compile dir. The top-level
    // node_modules link is NOT guaranteed: deno only links workspace
    // members' DIRECT deps there, and a lock rebuild can drop the
    // platform package (an optional dep of the SDK) to store-only — so
    // fall back to scanning the .deno store. Spawning some OTHER claude
    // must not happen: a PATH-resolved system CLI can mismatch the SDK's
    // control protocol and hang the first turn (spawns, writes JSONL
    // meta records, never processes the prompt — activity stuck
    // "running", interrupt unanswerable). Packaged builds replace this
    // with the embed+extract path in the packaging slice.
    const repoModules = `${Deno.cwd()}/../../node_modules`;
    const candidates = [
      `${repoModules}/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
    ];
    try {
      for await (const entry of Deno.readDir(`${repoModules}/.deno`)) {
        if (entry.name.startsWith("@anthropic-ai+claude-agent-sdk-darwin-")) {
          candidates.push(
            `${repoModules}/.deno/${entry.name}/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`,
          );
        }
      }
    } catch {
      // no .deno store (packaged layout) — top-level candidate only
    }
    let claudeExecutablePath: string | undefined;
    for (const c of candidates) {
      if (await Deno.stat(c).catch(() => null)) {
        claudeExecutablePath = c;
        break;
      }
    }
    if (claudeExecutablePath === undefined) {
      console.warn(
        "[desktop] SDK platform claude binary not found — falling back to SDK resolution (may pick a mismatched system CLI)",
      );
    }
    daemon = await startDaemon({ claudeExecutablePath });
    console.log(
      `[desktop] daemon up — fingerprint ${daemon.fingerprint}, pairedClients ${daemon.pairedClientCount()}`,
    );
  }
}

// One shutdown path for every exit trigger (tray Quit, SIGINT/SIGTERM):
// reap the vite child, then drain the daemon (WebRTC peers, claude
// subprocesses, JSONL writes) before the process dies. Idempotent —
// multiple triggers can fire. NOT reached by Cmd+Q / the app-menu Quit:
// laufey answers those with [NSApp terminate:] natively, which tears the
// runtime down without running JS — the daemon lock's pid-liveness check
// covers the stale lock that leaves behind.
let viteChild: Deno.ChildProcess | null = null;
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    viteChild?.kill();
  } catch {
    // already gone
  }
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
  if (url.pathname === "/api/pair/offer") {
    if (daemon === null) {
      // Another daemon owns ~/.sidecode — pairing belongs to IT, not us.
      return new Response(
        "daemon not running in this process — pairing unavailable",
        { status: 503 },
      );
    }
    // Same payload the menubar minted: a pure function of the daemon
    // identity plus this host's name (shown in iOS's confirm modal), so
    // no TTL and no refresh. Admission is gated by the pair window's
    // open/close (setPairing in openPairWindow), not by this call.
    return Response.json(daemon.createPairOffer(Deno.hostname()));
  }
  if (url.pathname.startsWith("/api/")) {
    return new Response("not found", { status: 404 });
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
const win =
  "BrowserWindow" in Deno
    ? new Deno.BrowserWindow({
        title: "Sidecode",
        width: 1200,
        height: 800,
      })
    : null;
// Menu-bar-app convention: the red button HIDES the main window and the app
// lives on in the tray + dock (hide also sidesteps the laufey close()
// SIGSEGV — see openPairWindow). Quitting is explicit: tray Quit (or Cmd+Q,
// which exits natively without reaching JS — see shutdown()).
//
// Keeper window: AppKit "retires" a window on hide just like on close, and
// once the window list is empty laufey's hardcoded
// applicationShouldTerminateAfterLastWindowClosed → YES kills the app
// (verified: hiding the only window exits the process ~1s later, no red
// button involved). So a 1×1 frameless opacity-0 window — invisible and
// unclickable, but never retired — keeps the list non-empty while main and
// pair windows hide. Drop it if laufey ever stops terminating tray apps.
if (win !== null) {
  new Deno.BrowserWindow({
    title: "keeper",
    width: 1,
    height: 1,
    x: 0,
    y: 0,
    frameless: true,
    opacity: 0,
  });
}
win?.addEventListener("close", () => {
  win.hide();
});
// Dock click while hidden brings the window back: deno swallows AppKit's
// default show-last-hidden behavior and hands the decision to `reopen`.
if (win !== null && "Dock" in Deno) {
  const dock = new Deno.Dock();
  dock.addEventListener("reopen", () => {
    win.show();
    win.focus();
  });
}
if (!win) {
  console.log(
    "[desktop] no desktop runtime — headless mode (server + daemon only)",
  );
}

// ─── Menu-bar tray (the menubar app's successor) ──────────────────────────
// Simplified menu only: label + enabled items — deliberately nothing that
// needs the MenuItem `checked`/`icon` fields (laufey has them since #27,
// deno hasn't plumbed them through). RIGHT-click opens the menu: laufey's
// webview backend hardcodes that split in tray_mac.mm (left-click is
// reserved for the `click` event / attachPanel toggling — unlike its winit
// backend, which inherits tray-icon's left-click-menu macOS default).
// Upstream alignment PR is the fix if left-click ever matters; a left-click
// handler here can't pop the menu (no such JS API). Plan-usage status rows
// join this menu in the next step (disabled label items, refreshed via
// setMenu).
//
// Pages served by this same process: Vite in dev, the runtime-chosen serve
// port otherwise (DENO_SERVE_ADDRESS — fixed ports are impossible here).
const pageBase = (() => {
  if (viteDev) return viteDev;
  const port = (Deno.env.get("DENO_SERVE_ADDRESS") ?? "").split(":").pop();
  return `http://127.0.0.1:${port}`;
})();

// Created once, reused forever, and NEVER close()d. The `close` event is a
// close REQUEST (laufey's windowShouldClose returns NO and defers to JS —
// Electron semantics), and answering it with close() SIGSEGVs the laufey
// backend and takes the whole app down: the traffic-light click leaves an
// AppKit _NSWindowTransformAnimation behind whose dealloc use-after-frees
// once the programmatic [win close] releases the window (repro'd against
// deno 2.9.2 / laufey 0.5.0; deferring via setTimeout doesn't help). So the
// red button HIDES the window instead, and reopening just shows it again.
// (The main window's handler is unaffected: it exits the process.)
let pairWin: Deno.BrowserWindow | null = null;
function openPairWindow(): void {
  // The window IS the admission gate (menubar semantics carried over):
  // showing it starts admitting pairing attempts, dismissing stops them —
  // so the QR "always works" exactly while it's visible, and no stranger
  // can pair against a daemon whose owner isn't looking at a pair window.
  daemon?.setPairing(true);
  if (pairWin === null) {
    pairWin = new Deno.BrowserWindow({
      title: "Pair New Device",
      width: 420,
      height: 680,
    });
    pairWin.navigate(`${pageBase}/pair`);
    pairWin.addEventListener("close", () => {
      daemon?.setPairing(false);
      pairWin?.hide();
    });
  }
  pairWin.show();
  pairWin.focus();
}

if (win !== null && "Tray" in Deno) {
  const tray = new Deno.Tray();
  // Same dual-root pattern as fsRoot: packaged = next to the compiled
  // entry (--include assets), dev --hmr = cwd.
  for (const root of [
    `${import.meta.dirname}/assets`,
    `${Deno.cwd()}/assets`,
  ]) {
    const png = await Deno.readFile(`${root}/tray.png`).catch(() => null);
    if (png) {
      tray.setIcon(png);
      break;
    }
  }
  tray.setTooltip("Sidecode");
  tray.setMenu([
    { item: { label: "Open Sidecode", id: "open", enabled: true } },
    { item: { label: "Pair New Device…", id: "pair", enabled: true } },
    "separator",
    { item: { label: "Quit Sidecode", id: "quit", enabled: true } },
  ]);
  tray.onmenuclick = (ev) => {
    switch (ev.detail.id) {
      case "open":
        win.show();
        win.focus();
        break;
      case "pair":
        openPairWindow();
        break;
      case "quit":
        void shutdown();
        break;
    }
  };
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
  // otherwise spawn one and tie its lifetime to the PROCESS via shutdown()
  // — NOT to the window's close event, which now merely hides the window
  // and would orphan-kill vite on the first hide.
  if (!(await alive())) {
    // Tell Vite's proxy where our (runtime-chosen) server actually is.
    const serveAddr = Deno.env.get("DENO_SERVE_ADDRESS") ?? "";
    const ptyTarget = `http://127.0.0.1:${serveAddr.split(":").pop()}`;
    viteChild = new Deno.Command("pnpm", {
      args: ["dev:web"],
      stdout: "inherit",
      stderr: "inherit",
      env: { ...Deno.env.toObject(), SIDECODE_PTY_TARGET: ptyTarget },
    }).spawn();
    for (let i = 0; i < 100 && !(await alive()); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  win.navigate(viteDev);
}
