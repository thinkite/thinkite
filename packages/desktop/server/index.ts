// Electron main (node process; built to dist-main/index.js by `bun run
// build:main`, esbuild with packages=external — everything resolves from
// node_modules at runtime). Serves the Vite-built SPA from dist/ and mounts
// our own routes (PTY WebSocket, daemon RPC, diff, pairing) on one
// fixed-port node http server — same port and routes as the electrobun and
// deno predecessors, so the renderer never noticed a runtime change.
//
// Dev:   bun run dev        (build:main + electron; probes/starts Vite HMR)
//        bun run dev:static (same, but skips Vite — exercises the built dist)
// Pack:  S3 (electron-builder) — not wired yet.
//
// S1 scope note: tray + pair window land in S2 (Electron Tray/Menu, harvested
// from the retired menubar app). Until then closing the window quits the app.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Daemon,
  readActiveDaemonLock,
  resolveSidecodeHome,
  start as startDaemon,
} from "@sidecodeapp/daemon";
import { app, BrowserWindow } from "electron";
import { WebSocketServer } from "ws";
import { handleDiff } from "./diff";
import { attachPty, ptyParams } from "./pty";
import { attachRpc } from "./rpc";

// Mode detection: `app.isPackaged` (real Electron signal — no more
// version.json channel probing; electrobun needed that because a stable
// .app launched from inside the repo defeated layout walk-ups, but
// isPackaged is stamped by the binary itself, not the filesystem).
//
// Dev: everything (dist/, the vite bin, the repo's node_modules) hangs off
// the package root = one level above dist-main/. A packaged app has its
// dist staged under process.resourcesPath by electron-builder (S3).
const HERE = dirname(fileURLToPath(import.meta.url)); // packages/desktop/dist-main
const PKG = app.isPackaged ? null : dirname(HERE);
const REPO = PKG ? dirname(dirname(PKG)) : null;
const DIST = PKG ? join(PKG, "dist") : join(process.resourcesPath, "dist");
console.log(
  `[desktop] boot — ${PKG ? `dev pkg ${PKG}` : `packaged ${process.resourcesPath}`}`,
);

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
const VITE_URL = "http://localhost:5183"; // strictPort in vite.config.ts

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
const MIN_CLAUDE = [2, 1, 0] as const;

async function resolveClaude(): Promise<string | undefined> {
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
  const which = (await run("/usr/bin/which", ["claude"]))?.trim();
  const candidates = [
    which,
    join(home, ".local/bin/claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ].filter((c): c is string => !!c);
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

function run(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

async function claudeVersion(
  bin: string,
): Promise<[number, number, number] | null> {
  const out = await run(bin, ["--version"]);
  const m = out?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// ─── In-process daemon (D2): this process IS the sidecode daemon ───────────
// Same identity, same ~/.sidecode home, same signaling presence the iOS app
// pairs against. `start()` only writes the liveness lock, so check it first:
// if another daemon owns the home (e.g. the menubar app), the GUI keeps
// working in local-only mode (PTY/diff don't need the daemon; sessions +
// transcripts do) rather than fighting over signaling with a twin identity.
//
// The daemon is a static import resolved from node_modules at runtime
// (esbuild packages=external) — a daemon rebuild needs no desktop
// re-bundle. Packaged builds revisit this in S3 (bundle + stage
// node-datachannel, the electrobun recipe carried over).
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

// ─── One shutdown path for every exit trigger (window close, SIGINT/SIGTERM)
// Reap the vite child, then drain the daemon (WebRTC peers, claude
// subprocesses, JSONL writes) before the process dies. Idempotent —
// multiple triggers can fire.
let viteChild: ReturnType<typeof import("node:child_process").spawn> | null =
  null;
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
  app.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

// ─── HTTP + WS server (fixed port, node http + ws) ─────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  try {
    if (url.pathname === "/api/daemon/status") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          daemon
            ? {
                running: true,
                fingerprint: daemon.fingerprint,
                pairedClients: daemon.pairedClientCount(),
                authenticatedPeers: daemon.authenticatedPeerCount(),
              }
            : { running: false },
        ),
      );
      return;
    }
    if (url.pathname === "/api/diff") {
      const r = await handleDiff(url);
      if ("json" in r) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json));
      } else {
        res.writeHead(r.status, { "content-type": "text/plain" });
        res.end(r.body);
      }
      return;
    }
    if (url.pathname === "/api/pair/offer") {
      if (daemon === null) {
        // Another daemon owns ~/.sidecode — pairing belongs to IT, not us.
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("daemon not running in this process — pairing unavailable");
        return;
      }
      // Same payload the menubar minted: a pure function of the daemon
      // identity plus this host's name (shown in iOS's confirm modal), so
      // no TTL and no refresh. Admission gating rejoins in S2 with the
      // pair window (setPairing on open/close).
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(daemon.createPairOffer(hostname())));
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    // Static SPA from dist/. SPA fallback only for HTML navigations, so
    // missing assets/API paths still 404.
    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    let file = join(DIST, rel);
    let st = await stat(file).catch(() => null);
    if (
      !st?.isFile() &&
      req.method === "GET" &&
      (req.headers.accept ?? "").includes("text/html")
    ) {
      file = join(DIST, "index.html");
      st = await stat(file).catch(() => null);
    }
    if (!st?.isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    res.end(await readFile(file));
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e));
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/pty") {
    const params = ptyParams(url);
    if (typeof params === "string") {
      socket.end(`HTTP/1.1 400 Bad Request\r\n\r\n${params}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachPty(ws, params));
  } else if (url.pathname === "/rpc") {
    if (daemon === null) {
      // The GUI shows its daemon-offline state off this instead of a dead
      // socket.
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\n\r\ndaemon not running in this process",
      );
      return;
    }
    const d = daemon;
    wss.handleUpgrade(req, socket, head, (ws) => attachRpc(ws, d));
  } else {
    socket.destroy();
  }
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
}).catch((e) => {
  console.error(
    `[desktop] port ${PORT} unavailable (another instance running?):`,
    e,
  );
  app.exit(1);
});
console.log(`[desktop] serving ${DIST} + /pty /rpc /api on ${BASE}`);

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
  const { spawn } = await import("node:child_process");
  viteChild = spawn(viteBin, [], {
    cwd: PKG,
    stdio: ["ignore", "inherit", "inherit"],
  });
  for (let i = 0; i < 100 && !(await alive()); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return (await alive()) ? VITE_URL : BASE;
})();

// ─── Window ─────────────────────────────────────────────────────────────────
let mainWin: BrowserWindow | null = null;
function openMain(): void {
  if (mainWin !== null) {
    mainWin.focus();
    return;
  }
  mainWin = new BrowserWindow({
    title: "Sidecode",
    x: 160,
    y: 120,
    width: 1200,
    height: 800,
    // Transparent titlebar: native traffic lights inset over the page; the
    // renderer detects Electron (userAgent) and renders a strip with native
    // `-webkit-app-region: drag` — no preload needed.
    titleBarStyle: "hiddenInset",
  });
  void mainWin.loadURL(`${pageBase}/`);
  mainWin.on("closed", () => {
    mainWin = null;
  });
}

// Dock click with no windows: recreate the main window.
app.on("activate", openMain);

// S1 lifecycle: closing the window quits (tray residency returns in S2 —
// then this handler becomes a no-op and quit moves to the tray menu).
app.on("window-all-closed", () => void shutdown());

// NOT `await app.whenReady()`: with an ESM entry Electron delays `ready`
// until the module's top-level evaluation (including every await above)
// finishes — a top-level await on whenReady is therefore a DEADLOCK (the
// daemon/server/vite booted, no window ever appeared). The .then() lets
// evaluation complete; ready fires right after, with pageBase already set.
void app.whenReady().then(openMain);
