// Electrobun entry (bun process; MUST be named index.ts — see the
// electrobun.config.ts entrypoint note). Serves the Vite-built SPA from dist/ and
// mounts our own routes (PTY WebSocket, daemon RPC, diff, pairing) on one
// fixed-port Bun.serve — the deno-desktop predecessor's env-relay dance
// (DENO_SERVE_ADDRESS → SIDECODE_PTY_TARGET) existed only because that
// runtime chose the port; a fixed port dissolves it.
//
// Dev:   bun run dev        (electrobun dev; probes/starts Vite for HMR)
//        bun run dev:static (same, but skips Vite — exercises the built dist)
// Pack:  bun run package    (vite build + daemon build + electrobun build;
//        renderer dist + tray icon ride under views/, daemon is bundled,
//        node-datachannel is staged — see electrobun.config.ts)
//
// Window model (the reason this file is short): electrobun's
// `exitOnLastWindowClosed: false` lets every window REALLY close while the
// app lives on in the tray/dock — no keeper window, no close→hide masquerade,
// none of the laufey lifecycle workarounds (close-request-only semantics,
// close() SIGSEGV, last-hidden-window termination) this file used to carry.

import { existsSync, readFileSync } from "node:fs";
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

// Mode detection: electrobun stamps Resources/version.json with the build
// channel ("dev" for `electrobun dev`, "stable"/"canary" for `electrobun
// build`) — the same field its own Updater keys on (build.json exists too
// but carries NO channel). NOT layout-based: a stable .app launched from
// packages/desktop/build/ still sits inside the repo, so a walk-up marker
// would misread it as dev and serve the repo's dist / spawn vite / pick
// the repo SDK binary.
//
// In dev, everything (dist/, assets/, the vite bin, the repo's
// node_modules) hangs off the package root, found by walking up from the
// bundle (build/dev-*/…/Resources/app/bun/) to electrobun.config.ts. A
// packaged app had its dist/tray/node_modules staged under Resources/app/
// by the config's `copy` map instead.
const APP_DIR = dirname(import.meta.dir); // Contents/Resources/app
const CHANNEL = (() => {
  try {
    const raw = JSON.parse(
      readFileSync(join(dirname(APP_DIR), "version.json"), "utf8"),
    ) as { channel?: string };
    return raw.channel ?? "dev";
  } catch {
    return "dev";
  }
})();
const PKG = (() => {
  if (CHANNEL !== "dev") return null; // packaged — never dev paths
  let dir = import.meta.dir;
  while (dir !== "/") {
    if (existsSync(join(dir, "electrobun.config.ts"))) return dir;
    dir = dirname(dir);
  }
  throw new Error(
    "dev channel but no electrobun.config.ts above the bundle — unexpected layout",
  );
})();
const REPO = PKG ? dirname(dirname(PKG)) : null;
const DIST = PKG ? join(PKG, "dist") : join(APP_DIR, "views/dist");
const TRAY_ICON = PKG
  ? join(PKG, "assets/tray.png")
  : join(APP_DIR, "views/assets/tray.png");
console.log(
  `[desktop] boot — channel ${CHANNEL}, ${PKG ? `dev pkg ${PKG}` : `packaged ${APP_DIR}`}`,
);

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
// The daemon import is mode-dependent (electrobun.config.ts): dev marks it
// `external` so it resolves through the repo's node_modules at runtime (a
// daemon rebuild needs no desktop re-bundle); packaged builds BUNDLE it and
// external only node-datachannel, whose native prebuild is staged into
// app/bun/node_modules where the daemon's lazy import finds it by walk-up.
let daemon: Daemon | null = null;
{
  const home = resolveSidecodeHome(); // ensures the dir exists
  const lock = readActiveDaemonLock(home);
  if (lock) {
    console.warn(
      `[desktop] another daemon owns ${home} (pid ${lock.pid}) — starting GUI without in-process daemon`,
    );
  } else {
    const claudeExecutablePath = await resolveClaude();
    if (claudeExecutablePath === undefined) {
      console.warn(
        "[desktop] no usable claude binary found — falling back to SDK resolution (may pick a mismatched CLI)",
      );
    }
    console.log(`[desktop] starting daemon — claude ${claudeExecutablePath}`);
    daemon = await startDaemon({ claudeExecutablePath });
    console.log(
      `[desktop] daemon up — fingerprint ${daemon.fingerprint}, pairedClients ${daemon.pairedClientCount()}`,
    );
  }
}

// Dev: spawn the SDK's platform-package claude binary from the REPO (same
// seam run-query.ts forwards) — top-level under bun's hoisted linker, .bun
// store under the isolated one.
//
// Packaged: no repo, and the SDK's 230MB platform binary is deliberately
// not shipped — discover the SYSTEM claude instead, gated by version.
// Spawning a mismatched CLI must not happen: an old CLI can mismatch the
// SDK's control protocol and hang the first turn (spawns, writes JSONL
// meta records, never processes the prompt), which is WORSE than failing
// loudly here. (Handshake watchdog = follow-up hardening.)
async function resolveClaude(): Promise<string | undefined> {
  // Inside the function: the daemon block above calls this via top-level
  // await BEFORE later module-level consts initialize (TDZ).
  const MIN_CLAUDE = [2, 1, 0] as const;
  if (REPO !== null) {
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
    for (const c of candidates) {
      if (await stat(c).catch(() => null)) return c;
    }
    return undefined;
  }
  // System discovery order: user PATH (meaningful when launched from a
  // terminal; Finder gives a bare one), then the native installer's
  // default, then Homebrew/npm-global prefixes.
  const home = process.env.HOME ?? "";
  const candidates = [
    Bun.which("claude"),
    join(home, ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter((c): c is string => c !== null && c !== undefined);
  for (const c of candidates) {
    if (!(await stat(c).catch(() => null))) continue;
    const version = await claudeVersion(c);
    if (version === null) {
      console.warn(
        `[desktop] ${c}: --version failed or unparseable — skipping`,
      );
      continue;
    }
    const ok =
      version[0] > MIN_CLAUDE[0] ||
      (version[0] === MIN_CLAUDE[0] &&
        (version[1] > MIN_CLAUDE[1] ||
          (version[1] === MIN_CLAUDE[1] && version[2] >= MIN_CLAUDE[2])));
    if (!ok) {
      console.warn(
        `[desktop] ${c}: version ${version.join(".")} < ${MIN_CLAUDE.join(".")} — skipping (control-protocol mismatch risk)`,
      );
      continue;
    }
    console.log(`[desktop] system claude ${version.join(".")} at ${c}`);
    return c;
  }
  return undefined;
}

async function claudeVersion(
  bin: string,
): Promise<[number, number, number] | null> {
  try {
    const proc = Bun.spawn([bin, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
      timeout: 5000,
    });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const m = out.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  } catch {
    return null;
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
  if (PKG === null || REPO === null) return BASE; // packaged — dist only
  if (await alive()) return VITE_URL;
  const viteBin = [
    join(PKG, "node_modules/.bin/vite"),
    join(REPO, "node_modules/.bin/vite"),
  ].find(existsSync);
  if (!viteBin) return BASE; // no vite on disk — serve dist
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
  image: TRAY_ICON,
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
