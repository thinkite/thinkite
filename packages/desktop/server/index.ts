// Electrobun entry (bun process; MUST be named index.ts — see the
// electrobun.config.ts entrypoint note). Serves the Vite-built SPA from dist/ and
// mounts our own routes (PTY WebSocket, daemon RPC, diff, pairing) on one
// fixed-port Bun.serve — the deno-desktop predecessor's env-relay dance
// (DENO_SERVE_ADDRESS → SIDECODE_PTY_TARGET) existed only because that
// runtime chose the port; a fixed port dissolves it.
//
// Dev:   bun run dev        (electrobun dev; main.ts probes/starts Vite for HMR)
//        bun run dev:static (same, but skips Vite — exercises the built dist)
// Pack:  electrobun build (packaging slice — dist embedding + system-claude
//        discovery + version gate land there).
//
// Window model (the reason this file is short): electrobun's
// `exitOnLastWindowClosed: false` lets every window REALLY close while the
// app lives on in the tray/dock — no keeper window, no close→hide masquerade,
// none of the laufey lifecycle workarounds (close-request-only semantics,
// close() SIGSEGV, last-hidden-window termination) this file used to carry.

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import {
  type Daemon,
  readActiveDaemonLock,
  resolveSidecodeHome,
  start as startDaemon,
} from "@sidecodeapp/daemon";
import { app, BrowserWindow, Tray } from "electrobun/bun";
import { handleDiff } from "./diff";
import {
  type PtyWsData,
  ptyClose,
  ptyMessage,
  ptyOpen,
  ptyUpgrade,
} from "./pty";
import {
  type RpcWsData,
  rpcClose,
  rpcMessage,
  rpcOpen,
  rpcUpgrade,
} from "./rpc";

// The bundle runs from build/dev-*/­Sidecode.app/Contents/Resources/app/bun/,
// so walk up to the package root (marked by electrobun.config.ts). Everything
// on disk — dist/, assets/, the vite bin, the repo's node_modules — hangs off
// it. A packaged app has no config above it: the packaging slice replaces
// this with embedded-resource paths.
const PKG = (() => {
  let dir = import.meta.dir;
  while (dir !== "/") {
    if (existsSync(join(dir, "electrobun.config.ts"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(
    "electrobun.config.ts not found above the bundle — packaged layout isn't wired yet (packaging slice)",
  );
})();
const REPO = dirname(dirname(PKG));
const DIST = join(PKG, "dist");
console.log(`[desktop] boot — pkg ${PKG}`);

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const VITE_URL = "http://localhost:5183"; // strictPort in vite.config.ts

// ─── In-process daemon (D2): this process IS the sidecode daemon ───────────
// Same identity, same ~/.sidecode home, same signaling presence the iOS app
// pairs against. `start()` only writes the liveness lock, so check it first:
// if another daemon owns the home (e.g. the menubar app), the GUI keeps
// working in local-only mode (PTY/diff don't need the daemon; sessions +
// transcripts do) rather than fighting over signaling with a twin identity.
//
// The import is real but marked `external` in electrobun.config.ts: bundling
// the daemon would inline its lazy node-datachannel loader away from the
// repo's node_modules, where the N-API prebuild actually lives. At runtime
// bun resolves it by walking up from the bundle to the repo root.
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
    // run-query.ts forwards). bun's default hoisted install puts the
    // platform package (an optional dep of the SDK) at top level; the
    // isolated linker keeps it store-only under .bun — scan that as a
    // fallback. Spawning some OTHER claude must not happen: a
    // PATH-resolved system CLI can mismatch the SDK's control protocol
    // and hang the first turn. Packaged builds replace this with
    // system-claude discovery + a version gate (packaging slice).
    const repoModules = join(REPO, "node_modules");
    const candidates = [
      join(repoModules, "@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"),
    ];
    try {
      for (const entry of await readdir(join(repoModules, ".bun"))) {
        if (entry.startsWith("@anthropic-ai+claude-agent-sdk-darwin-")) {
          candidates.push(
            join(
              repoModules,
              ".bun",
              entry,
              "node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude",
            ),
          );
        }
      }
    } catch {
      // no .bun store (hoisted layout) — top-level candidate only
    }
    let claudeExecutablePath: string | undefined;
    for (const c of candidates) {
      if (await stat(c).catch(() => null)) {
        claudeExecutablePath = c;
        break;
      }
    }
    if (claudeExecutablePath === undefined) {
      console.warn(
        "[desktop] SDK platform claude binary not found — falling back to SDK resolution (may pick a mismatched system CLI)",
      );
    }
    console.log(`[desktop] starting daemon — claude ${claudeExecutablePath}`);
    daemon = await startDaemon({ claudeExecutablePath });
    console.log(
      `[desktop] daemon up — fingerprint ${daemon.fingerprint}, pairedClients ${daemon.pairedClientCount()}`,
    );
  }
}

// ─── One shutdown path for every exit trigger (tray Quit, SIGINT/SIGTERM) ──
// Reap the vite child, then drain the daemon (WebRTC peers, claude
// subprocesses, JSONL writes) before the process dies. Idempotent —
// multiple triggers can fire.
let viteChild: Bun.Subprocess | null = null;
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
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// ─── HTTP + WS server (fixed port — impossible on deno desktop) ────────────
type WsData = PtyWsData | RpcWsData;

const server = Bun.serve<WsData, Record<string, never>>({
  port: PORT,
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/pty") return ptyUpgrade(req, srv);
    if (url.pathname === "/rpc") return rpcUpgrade(req, srv, daemon);
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
    if (url.pathname === "/api/diff") return await handleDiff(req);
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
      return Response.json(daemon.createPairOffer(hostname()));
    }
    if (url.pathname.startsWith("/api/")) {
      return new Response("not found", { status: 404 });
    }
    // Static SPA from dist/. SPA fallback only for HTML navigations, so
    // missing assets/API paths still 404.
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = Bun.file(DIST + rel);
    if (await file.exists()) return new Response(file);
    if (
      req.method === "GET" &&
      (req.headers.get("accept") ?? "").includes("text/html")
    ) {
      return new Response(Bun.file(join(DIST, "index.html")));
    }
    return new Response("not found", { status: 404 });
  },
  // Bun's websocket handlers are per-server, not per-socket — dispatch on
  // the discriminant stamped at upgrade time.
  websocket: {
    open(ws) {
      if (ws.data.kind === "pty") ptyOpen(ws as never);
      // rpcUpgrade already rejected when daemon is null.
      else if (daemon) rpcOpen(ws as never, daemon);
    },
    message(ws, msg) {
      if (ws.data.kind === "pty") ptyMessage(ws as never, msg as never);
      else rpcMessage(ws as never, msg as never);
    },
    close(ws) {
      if (ws.data.kind === "pty") ptyClose(ws as never);
      else rpcClose(ws as never);
    },
  },
});
console.log(`[desktop] serving ${DIST} + /pty /rpc /api on ${server.url}`);

// ─── Full React HMR loop (probe-first, no env relay) ───────────────────────
// If a Vite dev server is already up (separate `bun run dev:web`), reuse it;
// otherwise start one and tie its lifetime to the PROCESS via shutdown().
// Its proxy forwards /pty, /rpc and /api to our fixed port. A packaged app
// has no vite bin on disk and falls through to dist automatically;
// SIDECODE_DESKTOP_STATIC=1 forces dist in dev (`bun run dev:static`).
const pageBase = await (async () => {
  if (process.env.SIDECODE_DESKTOP_STATIC) return BASE;
  const alive = async () => {
    try {
      await fetch(VITE_URL, { method: "HEAD" });
      return true;
    } catch {
      return false;
    }
  };
  if (await alive()) return VITE_URL;
  const viteBin = [
    join(PKG, "node_modules/.bin/vite"),
    join(REPO, "node_modules/.bin/vite"),
  ].find(existsSync);
  if (!viteBin) return BASE; // packaged layout — serve dist
  viteChild = Bun.spawn([viteBin], {
    cwd: PKG,
    stdout: "inherit",
    stderr: "inherit",
  });
  for (let i = 0; i < 100 && !(await alive()); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return (await alive()) ? VITE_URL : BASE;
})();

// ─── Windows: REAL close semantics ─────────────────────────────────────────
let mainWin: BrowserWindow | null = null;
function openMain(): void {
  if (mainWin !== null) {
    mainWin.focus();
    return;
  }
  mainWin = new BrowserWindow({
    title: "Sidecode",
    url: `${pageBase}/`,
    frame: { x: 160, y: 120, width: 1200, height: 800 },
    // Transparent titlebar: native traffic lights inset over the page; the
    // renderer detects electrobun (preload stamps __electrobunWindowId) and
    // renders the drag strip the preload's drag-region handler picks up.
    titleBarStyle: "hiddenInset",
  });
  mainWin.on("close", () => {
    // Real close; the app lives on in tray/dock. PTY sessions live
    // server-side and survive this.
    mainWin = null;
  });
}

let pairWin: BrowserWindow | null = null;
function openPairWindow(): void {
  if (pairWin !== null) {
    pairWin.focus();
    return;
  }
  // The window IS the admission gate (menubar semantics carried over):
  // showing it starts admitting pairing attempts, dismissing stops them —
  // so the QR "always works" exactly while it's visible, and no stranger
  // can pair against a daemon whose owner isn't looking at a pair window.
  daemon?.setPairing(true);
  pairWin = new BrowserWindow({
    title: "Pair New Device",
    url: `${pageBase}/pair`,
    frame: { x: 560, y: 200, width: 420, height: 680 },
  });
  pairWin.on("close", () => {
    daemon?.setPairing(false);
    pairWin = null;
  });
}

// Dock click with no windows: recreate the main window.
app.on("reopen", () => {
  openMain();
});

// ─── Menu-bar tray ──────────────────────────────────────────────────────────
// Plan-usage status rows join this menu later (disabled label items,
// refreshed via setMenu).
const tray = new Tray({
  image: join(PKG, "assets/tray.png"),
  template: true,
  width: 18,
  height: 18,
});
tray.setMenu([
  { type: "normal", label: "Open Sidecode", action: "open" },
  { type: "normal", label: "Pair New Device…", action: "pair" },
  { type: "separator" },
  { type: "normal", label: "Quit Sidecode", action: "quit" },
]);
tray.on("tray-clicked", (event) => {
  const action = (event as { data?: { action?: string } })?.data?.action;
  switch (action) {
    case "open":
      openMain();
      break;
    case "pair":
      openPairWindow();
      break;
    case "quit":
      void shutdown();
      break;
  }
});

openMain();
