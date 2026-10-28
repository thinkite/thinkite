// Electron main (node process; bundled to dist-electron/index.js by
// vite-plugin-electron — externals resolve from node_modules at runtime).
// Serves the Vite-built SPA from dist/ and mounts our own routes (PTY
// WebSocket, opencode proxy, pairing) on one fixed-port node http server —
// same port and routes as the electrobun and deno predecessors, so the
// renderer never noticed a runtime change.
//
// Dev:   bun run dev        (vite — the plugin builds this file, spawns
//        Electron with VITE_DEV_SERVER_URL, and rebuild+restarts on main
//        changes; NOTE: a main-file save bounces the daemon and kills live
//        PTY shells, deliberate trade for the auto-restart loop)
//        bun run dev:static (vite build + electron; no dev server —
//        exercises the built dist)
// Pack:  S3 (electron-builder) — not wired yet.
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Daemon,
  type PreviewSnapshot,
  readActiveDaemonLock,
  resolveThinkiteHome,
  runPluginCommand,
  start as startDaemon,
  startsTask,
} from "@thinkite/daemon";
import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  powerSaveBlocker,
  shell,
  Tray,
} from "electron";
import { WebSocketServer } from "ws";
import { guardWebviews, setupBrowserGuests } from "./browser-guests";
import { handleOcProxy, stripOcPrefix } from "./oc-proxy";
import { listOpenInApps, openIn, openInIcon } from "./open-in";
import { attachPty, killPty, killPtys, ptyParams } from "./pty";
import { createRequestGuard } from "./request-guard";
import {
  checkForUpdates,
  getUpdateInfo,
  getUpdateState,
  initUpdater,
  quitAndInstall,
} from "./updater";

// ─── Single instance ────────────────────────────────────────────────────────
// The port-conflict guard alone made a second launch die AFTER booting a
// twin daemon; the lock stops it before any of that, and hands the gesture
// to the running instance (which raises its window).
if (!app.requestSingleInstanceLock()) {
  app.exit(0);
  // exit() tears the process down asynchronously — stop evaluating so the
  // daemon/server boot below never starts in the doomed instance.
  await new Promise<never>(() => {});
}
app.on("second-instance", () => openMain());

// Mode detection: `app.isPackaged` (real Electron signal — no more
// version.json channel probing; electrobun needed that because a stable
// .app launched from inside the repo defeated layout walk-ups, but
// isPackaged is stamped by the binary itself, not the filesystem).
//
// Dev: everything (dist/, assets/, the repo's node_modules) hangs off the
// package root = one level above dist-electron/. A packaged app has dist/
// and assets/ staged under process.resourcesPath by electron-builder (S3).
const HERE = dirname(fileURLToPath(import.meta.url)); // <root>/dist-electron
// Dev root = the package dir; packaged root = app.getAppPath() (app.asar —
// Electron's asar-patched fs lets the http server readFile straight out of
// the archive, so dist/ and assets/ ship INSIDE it, no extraResources).
const ROOT = app.isPackaged ? app.getAppPath() : dirname(HERE);
const PKG = app.isPackaged ? null : ROOT;
const DIST = join(ROOT, "dist");
const TRAY_ICON = join(ROOT, "assets/iconTemplate.png");
console.log(
  `[desktop] boot — ${PKG ? `dev pkg ${PKG}` : `packaged ${process.resourcesPath}`}`,
);

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}`;
// vite-plugin-electron stamps the dev-server origin into our env in dev;
// absence (dev:static, packaged) means serve the built dist ourselves.
const pageBase = process.env.VITE_DEV_SERVER_URL ?? BASE;

// ─── In-process daemon: this process IS the Thinkite daemon ────────────────
// Same identity, same ~/.thinkite home, same iroh endpoint the iOS app
// pairs against. `start()` only writes the liveness lock, so check it first:
// if another daemon owns the home (`thinkite up`), the GUI keeps working
// without one (the PTY doesn't need it; the `/oc` proxy does) rather
// than publishing a twin identity to discovery.
//
// The daemon is external in the main bundle, resolved from node_modules at
// runtime — a daemon rebuild needs no desktop re-bundle. Packaged builds
// revisit this in S3 (bundle + stage @number0/iroh, the electrobun
// recipe carried over).
let daemon: Daemon | null = null;
{
  const home = resolveThinkiteHome(); // ensures the dir exists
  const lock = readActiveDaemonLock(home);
  if (lock) {
    console.warn(
      `[desktop] another daemon owns ${home} (pid ${lock.pid}) — starting GUI without in-process daemon`,
    );
  } else {
    daemon = await startDaemon();
    console.log(
      `[desktop] daemon up — fingerprint ${daemon.fingerprint}, pairedClients ${daemon.pairedClientCount()}`,
    );
    // Opening the app starts opencode when it isn't running, as the
    // OpenCode desktop app does; the window's first reads wait on it.
    daemon.opencode({ start: true }).catch((e: unknown) => {
      console.warn(`[desktop] opencode didn't start: ${e}`);
    });
  }
}

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

// The routes answer only Thinkite's own page (server/request-guard.ts).
const fromApp = createRequestGuard([
  BASE,
  `http://localhost:${PORT}`,
  pageBase,
]);

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  try {
    if (
      (url.pathname.startsWith("/api/") ||
        url.pathname === "/oc" ||
        url.pathname.startsWith("/oc/")) &&
      !fromApp(req.headers)
    ) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
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
    if (url.pathname === "/api/pair/offer") {
      if (daemon === null) {
        // Another daemon owns ~/.sidecode — pairing belongs to IT, not us.
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("daemon not running in this process — pairing unavailable");
        return;
      }
      // Same payload the menubar minted: a pure function of the daemon
      // identity plus this host's name (shown in iOS's confirm modal), so
      // no TTL and no refresh. Admission is gated by the pair window's
      // open/close (setPairing in openPairWindow), not by this call.
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(daemon.createPairOffer(hostname())));
      return;
    }
    if (url.pathname === "/api/badge" && req.method === "POST") {
      // The Dock badge: how many sessions wait on the user (sidebar).
      const count = Number(url.searchParams.get("count") ?? 0);
      app.setBadgeCount(Number.isInteger(count) && count > 0 ? count : 0);
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/api/pty/kill" && req.method === "POST") {
      // One closed tab's shell (`name`), or all of a deleted or archived
      // chat session's (`session`; lib/oc).
      const name = /^[A-Za-z0-9_-]{1,64}$/;
      const one = url.searchParams.get("name") ?? "";
      const all = url.searchParams.get("session") ?? "";
      if (name.test(one)) killPty(one);
      if (name.test(all)) killPtys(all);
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/api/pair/window" && req.method === "POST") {
      // Settings › Pairing's button. Pairing stays the pair window's job:
      // admission is open exactly while that window is visible.
      if (daemon === null) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("daemon not running in this process — pairing unavailable");
        return;
      }
      openPairWindow();
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === "/api/pick-directory") {
      // Landing-page directory picker: native Electron dialog (renderer
      // has no fs access). Remembers nothing server-side — the renderer
      // keeps the last pick in localStorage.
      const win =
        mainWin !== null && !mainWin.isDestroyed() ? mainWin : undefined;
      const picked =
        win !== undefined
          ? await dialog.showOpenDialog(win, {
              properties: ["openDirectory", "createDirectory"],
            })
          : await dialog.showOpenDialog({
              properties: ["openDirectory", "createDirectory"],
            });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          picked.canceled || picked.filePaths.length === 0
            ? { canceled: true }
            : { canceled: false, path: picked.filePaths[0] },
        ),
      );
      return;
    }
    // The session title bar's "Open in" (server/open-in.ts): the installed
    // apps, each one's icon, and opening the session's folder in one.
    if (url.pathname === "/api/open-in" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(await listOpenInApps()));
      return;
    }
    if (url.pathname === "/api/open-in/icon") {
      const png = await openInIcon(url.searchParams.get("app") ?? "");
      if (png === null) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not installed");
        return;
      }
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "max-age=3600",
      });
      res.end(png);
      return;
    }
    if (url.pathname === "/api/open-in" && req.method === "POST") {
      const directory = url.searchParams.get("directory") ?? "";
      if (!isAbsolute(directory)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("directory must be absolute");
        return;
      }
      try {
        await openIn(url.searchParams.get("app") ?? "", directory);
        res.writeHead(204);
        res.end();
      } catch (e) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // Settings › Extensions › Plugins: install or uninstall a plugin with
    // the opencode CLI (the server has no route for either); the service
    // reloads its plugins when the CLI rewrites opencode.json.
    const plugin = /^\/api\/plugins\/(add|remove)$/.exec(url.pathname);
    if (plugin && req.method === "POST") {
      try {
        await runPluginCommand(
          plugin[1] as "add" | "remove",
          url.searchParams.get("spec") ?? "",
        );
        res.writeHead(204);
        res.end();
      } catch (e) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    // The window's update button and About page (src/lib/update.ts) read
    // the same state as the tray menu, and act through the same calls.
    if (url.pathname === "/api/update") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getUpdateInfo()));
      return;
    }
    if (url.pathname === "/api/update/check" && req.method === "POST") {
      checkForUpdates();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getUpdateInfo()));
      return;
    }
    if (url.pathname === "/api/update/install" && req.method === "POST") {
      quitAndInstall();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getUpdateInfo()));
      return;
    }
    // Pushes "changed" for one folder's repository (the daemon's git
    // watcher), so the renderer reads opencode's counts again mid-turn and
    // after a reset or stash outside the app (lib/git-events).
    if (url.pathname === "/api/git/events") {
      const directory = url.searchParams.get("directory");
      if (daemon === null || directory === null || !isAbsolute(directory)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("directory required");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write(": watching\n\n");
      const stop = daemon.watchGit(directory, () => {
        res.write("data: changed\n\n");
      });
      req.on("close", stop);
      return;
    }
    // The servers the agent started in one folder and the pages it asked
    // to open (the daemon's preview registry): the whole snapshot at once,
    // then again after every change (lib/previews).
    if (url.pathname === "/api/previews/events") {
      const directory = url.searchParams.get("directory");
      if (daemon === null || directory === null || !isAbsolute(directory)) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("directory required");
        return;
      }
      const previews = daemon.previews;
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      const send = (snapshot: PreviewSnapshot) =>
        res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      const stop = previews.subscribe(directory, send);
      req.on("close", stop);
      previews.snapshot(directory).then(send, () => send({ entries: [] }));
      return;
    }
    // The Servers card's stop button: the agent's server_stop, recorded as
    // the user's.
    if (url.pathname === "/api/previews/stop" && req.method === "POST") {
      const directory = url.searchParams.get("directory") ?? "";
      const name = url.searchParams.get("name") ?? "";
      if (daemon === null || !isAbsolute(directory) || name === "") {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("directory and name required");
        return;
      }
      const outcome = await daemon.previews.stop(directory, name, {
        by: "user",
      });
      res.writeHead(outcome.isError ? 404 : 204, {
        "content-type": "text/plain",
      });
      res.end(outcome.isError ? outcome.text : undefined);
      return;
    }
    if (url.pathname === "/oc" || url.pathname.startsWith("/oc/")) {
      // Same-origin opencode endpoint (see server/oc-proxy.ts): strip +
      // forward with the daemon-owned Basic credentials of the user's
      // registered opencode service; 502 while none is running, except
      // that a request starting a task starts one first.
      if (daemon === null) {
        res.writeHead(503, { "content-type": "text/plain" });
        res.end("daemon not running in this process — opencode unavailable");
        return;
      }
      let upstream: { baseUrl: string; username: string; password: string };
      try {
        upstream = await daemon.opencode({
          start: startsTask(req.method, stripOcPrefix(req.url ?? "/oc")),
        });
      } catch (e) {
        res.writeHead(502, { "content-type": "text/plain" });
        res.end(`opencode unavailable: ${e}`);
        return;
      }
      handleOcProxy(req, res, upstream);
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
  if (!fromApp(req.headers)) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  if (url.pathname === "/pty") {
    const params = ptyParams(url);
    if (typeof params === "string") {
      socket.end(`HTTP/1.1 400 Bad Request\r\n\r\n${params}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => attachPty(ws, params));
  } else {
    socket.destroy();
  }
});

await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(PORT, "127.0.0.1", resolve);
}).catch((e) => {
  console.error(`[desktop] port ${PORT} unavailable:`, e);
  app.exit(1);
});
console.log(`[desktop] serving ${DIST} + /pty /api /oc on ${BASE}`);

// ─── Windows ────────────────────────────────────────────────────────────────
let mainWin: BrowserWindow | null = null;
function openMain(): void {
  if (mainWin !== null) {
    mainWin.focus();
    return;
  }
  mainWin = new BrowserWindow({
    title: "Thinkite",
    x: 160,
    y: 120,
    width: 1200,
    height: 800,
    // Transparent titlebar: the traffic lights sit in the sidebar's top
    // row, centred on y 24 like its collapse button and the session title
    // (DeepSeek Harness's placement). The renderer marks those rows as drag
    // regions (lib/desktop-shell) — no preload needed.
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 18 },
    // The session panel's browser (server/browser-guests).
    webPreferences: { webviewTag: true },
    // Shown once the page has painted, so it never opens blank white.
    show: false,
  });
  mainWin.once("ready-to-show", () => mainWin?.show());
  guardWebviews(mainWin);
  void mainWin.loadURL(`${pageBase}/`);
  // Pages the app opens (a provider's sign-in, a link in a reply) open in
  // the user's browser, never in an app window.
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWin.on("closed", () => {
    // Real close; the app lives on in the tray/dock. PTY sessions live
    // server-side and survive this.
    mainWin = null;
  });
}

let pairWin: BrowserWindow | null = null;
function openPairWindow(): void {
  if (pairWin !== null && !pairWin.isDestroyed()) {
    pairWin.focus();
    return;
  }
  // The window IS the admission gate (menubar semantics carried over):
  // showing it starts admitting pairing attempts, dismissing stops them —
  // so the QR "always works" exactly while it's visible, and no stranger
  // can pair against a daemon whose owner isn't looking at a pair window.
  daemon?.setPairing(true);
  const win = new BrowserWindow({
    width: 420,
    height: 680,
    show: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    titleBarStyle: "hiddenInset",
    // Per-window title. The shared index.html ships a <title>, which
    // Electron would otherwise copy onto every window that loads it; the
    // `page-title-updated` preventDefault below locks this in (visible in
    // Mission Control / window menus, not in the hidden bar).
    title: "Pair New Device",
  });
  void win.loadURL(`${pageBase}/pair`);
  win.on("page-title-updated", (e) => e.preventDefault());
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    // Window closed → close the admission gate. Already-paired clients
    // still reconnect; only NEW unknown-pubkey pairing is gated.
    daemon?.setPairing(false);
    pairWin = null;
  });
  pairWin = win;
}

// ─── Tray: actions (harvested from the retired menubar app) ────────────────
let tray: Tray | null = null;
let keepAwakeId: number | null = null;

// SF Symbol → 16x16 template image (auto-tints to follow menu fg color,
// turns white when highlighted). macOS HIG size for menu item icons.
const MENU_ICON_SIZE = 16;
function symbolIcon(name: string): Electron.NativeImage {
  const img = nativeImage
    .createFromNamedImage(name)
    .resize({ width: MENU_ICON_SIZE, height: MENU_ICON_SIZE });
  img.setTemplateImage(true);
  return img;
}

// State-adaptive update row driven by electron-updater (server/updater.ts).
// Shown only when there's something to convey; idle/error fall back to the
// manual "Check for updates" in the About submenu.
function updateMenuItem(): Electron.MenuItemConstructorOptions | null {
  const s = getUpdateState();
  switch (s.status) {
    case "checking":
      return { label: "Checking for updates…", enabled: false };
    case "downloading":
      return { label: `Downloading update… ${s.percent}%`, enabled: false };
    case "downloaded":
      return {
        label: `Restart to update · v${s.version}`,
        icon: symbolIcon("arrow.up.circle"),
        click: () => quitAndInstall(),
      };
    case "installing":
      return { label: "Restarting to update…", enabled: false };
    default:
      return null; // idle | error
  }
}

function buildMenu(): Electron.Menu {
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Open Thinkite",
      icon: symbolIcon("macwindow"),
      click: () => openMain(),
    },
    {
      label: "Pair new device",
      icon: symbolIcon("link"),
      click: () => openPairWindow(),
    },
    {
      label: "Settings",
      icon: symbolIcon("gear"),
      submenu: [
        {
          label: "Launch at login",
          type: "checkbox",
          checked: app.isPackaged && app.getLoginItemSettings().openAtLogin,
          enabled: app.isPackaged,
          sublabel: app.isPackaged ? undefined : "Packaged build only",
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked });
          },
        },
        {
          label: "Keep computer awake",
          type: "checkbox",
          checked:
            keepAwakeId !== null && powerSaveBlocker.isStarted(keepAwakeId),
          click: (item) => {
            if (item.checked) {
              keepAwakeId = powerSaveBlocker.start("prevent-display-sleep");
            } else if (keepAwakeId !== null) {
              powerSaveBlocker.stop(keepAwakeId);
              keepAwakeId = null;
            }
          },
        },
      ],
    },
    { type: "separator" },
  ];

  const updateItem = updateMenuItem();
  if (updateItem) items.push(updateItem);

  items.push(
    {
      label: "About Thinkite",
      icon: symbolIcon("info.circle"),
      submenu: [
        { label: `Version ${app.getVersion()}`, enabled: false },
        {
          label: "Check for updates",
          // Interactive: a user-initiated check always answers with a
          // dialog (up to date / restart prompt / error) — Sparkle
          // convention; scheduled checks stay silent.
          click: () => checkForUpdates({ interactive: true }),
        },
        {
          label: "View on GitHub",
          click: () => {
            void shell.openExternal("https://github.com/thinkite/thinkite");
          },
        },
      ],
    },
    { type: "separator" },
    {
      label: "Quit Thinkite",
      accelerator: "CommandOrControl+Q",
      click: () => app.quit(),
    },
  );
  return Menu.buildFromTemplate(items);
}

function refreshMenu(): void {
  tray?.setContextMenu(buildMenu());
  // Download progress lives in the tray TITLE (text beside the icon) — the
  // one surface visible without opening anything; macOS doesn't repaint an
  // already-open NSMenu.
  const s = getUpdateState();
  tray?.setTitle(s.status === "downloading" ? ` ${s.percent}%` : "");
}

function setupTray(): void {
  // Monochrome template image (black + alpha): macOS tints via the alpha
  // mask — dark glyph on light menu bars, light on dark, inverted on
  // highlight. createFromPath auto-pairs the @2x file; setTemplateImage is
  // an explicit guard on top of the Template filename suffix.
  const icon = nativeImage.createFromPath(TRAY_ICON);
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on("click", refreshMenu);
  tray.on("right-click", refreshMenu);
  refreshMenu();
}

// ─── Lifecycle: tray-resident ───────────────────────────────────────────────
// Closing every window keeps the app (and daemon) alive in the tray/dock —
// the electrobun `exitOnLastWindowClosed:false` semantics, natively.
// Registering the (no-op) handler is what overrides Electron's default
// quit-on-last-window.
app.on("window-all-closed", () => {});

// Dock click with no windows: recreate the main window.
app.on("activate", openMain);

// One shutdown path for every exit trigger (tray Quit, Cmd+Q, SIGINT/
// SIGTERM): intercept quit once, drain the daemon (iroh peers, git
// watchers), then exit HARD.
//
// app.exit(0), NOT a second app.quit(): the polite second pass (close
// windows → will-quit) was observed to wedge INDEFINITELY after ^C under
// vite-plugin-electron dev — the daemon drained, then the process sat
// there ignoring further signals. After the drain there is nothing left
// worth being polite about (renderer holds no unsaved state; PTY shells
// die with the process by design), and S1's exit(0) path never wedged
// once. The 5s race guards a hung daemon.stop().
let isQuitting = false;
app.on("before-quit", (event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  const stop = daemon ? daemon.stop() : Promise.resolve();
  void Promise.race([
    stop.catch((e) => console.error("[desktop] daemon stop failed:", e)),
    new Promise((r) => setTimeout(r, 5000)),
  ]).then(() => app.exit(0));
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => app.quit());
}

// NOT `await app.whenReady()`: with an ESM entry Electron delays `ready`
// until the module's top-level evaluation (including every await above)
// finishes — a top-level await on whenReady is therefore a DEADLOCK (the
// daemon and server booted, no window ever appeared). The .then() lets
// evaluation complete; ready fires right after.
void app.whenReady().then(() => {
  setupBrowserGuests({ appOrigins: [BASE, pageBase] });
  setupTray();
  // Auto-download + drive the update menu row / tray-title percent.
  // Inert in dev (packaged-only inside).
  initUpdater({ onStateChange: refreshMenu });
  openMain();
});
