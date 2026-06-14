import { hostname } from "node:os";
import path from "node:path";
import {
  type Daemon,
  type PlanUsageResult,
  type PlanUsageWindow,
  start as startDaemon,
} from "@sidecodeapp/daemon";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  powerSaveBlocker,
  shell,
  Tray,
} from "electron";
import {
  checkForUpdates,
  getUpdateState,
  initUpdater,
  quitAndInstall,
} from "./updater";

let tray: Tray | null = null;
let pairWindow: BrowserWindow | null = null;
let isQuitting = false;
let daemon: Daemon | null = null;
let keepAwakeId: number | null = null;

// --- Plan usage (daemon-fetched, menu-cached) ---
//
// Last fetch result, rendered by buildMenu. macOS doesn't repaint an open
// NSMenu, so the open itself can only ever paint an ALREADY-cached snapshot —
// a tray click can't show its own in-flight fetch. A background poll
// (PLAN_USAGE_POLL_MS) keeps the cache warm so each open shows near-current
// data; without it an open showed the *previous* open's snapshot. The
// startup + per-open `refreshPlanUsage()` calls stay (the daemon's 30s cache
// + single-flight make the extra fetches free), but the poll is what makes
// the displayed number fresh.
// Token Stats was CUT from V0: its planned source (stats-cache.json) turned
// out to be lazily written — only when the user runs /stats — so honest
// numbers require Desktop-style JSONL aggregation; deferred.
let planUsage: PlanUsageResult | null = null;
// Background poller handle, cleared on quit. 2 min: the daemon's 30s TTL
// coalesces anything faster, and plan usage drifts slowly, so a tighter
// interval would just burn requests for no visible gain.
const PLAN_USAGE_POLL_MS = 2 * 60_000;
let planUsageTimer: ReturnType<typeof setInterval> | null = null;

function refreshPlanUsage(): void {
  if (!daemon) return;
  void daemon.fetchPlanUsage().then((result) => {
    // Keep showing the last good snapshot through transient failures —
    // a flaky network shouldn't blank the section.
    if (result.status === "error" && planUsage?.status === "ok") return;
    planUsage = result;
    refreshMenu();
  });
}

// --- Formatters ---

// The usage endpoint returns utilization as 0..100 already (live-verified:
// `71` = 71%), NOT a 0..1 fraction — do not multiply.
function formatPercent(util: number): string {
  return `${Math.round(util)}%`;
}

// Coarse single-unit countdown: "resets 42m" / "resets 7h" / "resets 3d".
// Ceil everywhere so the label never understates the wait ("resets 0m"
// while 30s remain would read as a bug).
function formatResets(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return "resets now";
  const min = Math.ceil(ms / 60_000);
  if (min < 60) return `resets ${min}m`;
  const hours = Math.ceil(min / 60);
  if (hours < 24) return `resets ${hours}h`;
  return `resets ${Math.ceil(hours / 24)}d`;
}

// SF Symbol → 16x16 template image (auto-tints to follow menu fg color,
// turns white when item is highlighted). macOS HIG recommends 16x16 for
// menu item icons.
const MENU_ICON_SIZE = 16;
function symbolIcon(name: string): Electron.NativeImage {
  const img = nativeImage
    .createFromNamedImage(name)
    .resize({ width: MENU_ICON_SIZE, height: MENU_ICON_SIZE });
  img.setTemplateImage(true);
  return img;
}

// --- Menu builder ---

// State-adaptive update row driven by electron-updater (electron/updater.ts).
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
    default:
      return null; // idle | error
  }
}

// One disabled info row per available rate window. Windows the endpoint
// didn't return (enterprise/org accounts) are skipped, never shown as 0%.
function planUsageItems(): Electron.MenuItemConstructorOptions[] {
  if (planUsage === null) {
    return [{ label: "Loading…", enabled: false }];
  }
  switch (planUsage.status) {
    case "signed_out":
      return [{ label: "Not signed in — run `claude /login`", enabled: false }];
    case "error":
      // Only reached when there's no last-good snapshot to keep showing
      // (refreshPlanUsage drops transient errors otherwise).
      return [{ label: "Usage unavailable", enabled: false }];
    case "ok": {
      const u = planUsage.usage;
      const row = (
        name: string,
        w: PlanUsageWindow | undefined,
        showReset = false,
      ): Electron.MenuItemConstructorOptions | null =>
        w
          ? {
              label: `${name} - ${formatPercent(w.utilization)}${
                showReset && w.resetsAt ? ` · ${formatResets(w.resetsAt)}` : ""
              }`,
              enabled: false,
            }
          : null;
      const rows = [
        row("5h", u.fiveHour, true),
        row("Weekly", u.sevenDay, true),
        row("Opus", u.sevenDayOpus),
        row("Sonnet", u.sevenDaySonnet),
      ].filter((r) => r !== null);
      return rows.length > 0
        ? rows
        : [{ label: "No usage data for this plan", enabled: false }];
    }
  }
}

function buildMenu(): Electron.Menu {
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "Claude Plan Usage", type: "header" },
    ...planUsageItems(),
    { type: "separator" },
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
      label: "About Sidecode",
      icon: symbolIcon("info.circle"),
      submenu: [
        { label: `Version ${app.getVersion()}`, enabled: false },
        {
          label: "Check for updates",
          // interactive: a user-initiated check always answers with a
          // dialog (up to date / restart prompt / error) — Sparkle
          // convention; scheduled checks stay silent.
          click: () => checkForUpdates({ interactive: true }),
        },
        {
          label: "View on GitHub",
          click: () => {
            void shell.openExternal("https://github.com/sidecodeapp/sidecode");
          },
        },
      ],
    },
    { type: "separator" },
    {
      label: "Quit",
      accelerator: "CommandOrControl+Q",
      click: () => app.quit(),
    },
  );

  return Menu.buildFromTemplate(items);
}

function refreshMenu() {
  tray?.setContextMenu(buildMenu());
  // Download progress lives in the tray TITLE (text beside the icon) — the
  // one surface a menu bar app can update that's visible without opening
  // anything. macOS doesn't repaint an already-open NSMenu, so the menu row
  // alone would only show progress on the next open.
  const s = getUpdateState();
  tray?.setTitle(s.status === "downloading" ? ` ${s.percent}%` : "");
}

// --- Pair window ---

function openPairWindow() {
  if (pairWindow && !pairWindow.isDestroyed()) {
    pairWindow.focus();
    return;
  }
  // The Pair window being open IS the admission gate: open it now, close it
  // in the `closed` handler below. No TTL — closing the window stops
  // admitting unknown pubkeys immediately.
  daemon?.setPairing(true);
  const win = new BrowserWindow({
    width: 420,
    height: 600,
    show: false,
    resizable: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    // Hidden title bar — traffic lights stay overlaid at top-left, the
    // rest of the chrome is owned by the React shell. Drag is enabled
    // via a `-webkit-app-region: drag` strip in PairView's Shell.
    titleBarStyle: "hiddenInset",
    // Per-window title. The shared index.html ships a <title>, which Electron
    // would otherwise copy onto every window that loads it; `page-title-updated`
    // preventDefault (below) locks this in so the Pair window keeps its own
    // name (visible in Mission Control / window menus, not in the hidden bar).
    title: "Pair a Device",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(import.meta.dirname, "preload.mjs"),
    },
  });
  const url = process.env.VITE_DEV_SERVER_URL;
  if (url) {
    void win.loadURL(`${url}#pair`);
  } else {
    void win.loadFile(path.join(import.meta.dirname, "../dist/index.html"), {
      hash: "pair",
    });
  }
  // Keep the BrowserWindow `title` above instead of inheriting the document's
  // <title> from index.html.
  win.on("page-title-updated", (e) => e.preventDefault());
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    // Window closed → close the admission gate. Already-paired clients still
    // reconnect; only NEW unknown-pubkey pairing is gated.
    daemon?.setPairing(false);
    pairWindow = null;
  });
  pairWindow = win;
}

// --- Lifecycle ---

// Menu bar apps must override Electron's default "quit when all BrowserWindows
// closed" behavior — otherwise closing the pair window would kill the daemon.
// Just registering a (no-op) handler is enough on Electron 42+.
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  app.dock?.hide();

  // Register an application-level menu so Cmd+Q works when the Pair window
  // has focus. The menu doesn't render visually (LSUIElement app via
  // dock.hide()), but its accelerator bindings are active app-wide.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [{ role: "quit" }],
      },
    ]),
  );

  console.log("[main] starting daemon...");
  daemon = await startDaemon();
  console.log(
    `[main] daemon ready (fingerprint ${daemon.fingerprint}, ${daemon.pairedClientCount()} paired clients)`,
  );

  // Mint the QR payload for PairView. Pure (the same daemon always mints the
  // same offer), so PairView calls this once. `hostname()` is surfaced as
  // `serviceName` in iOS's confirm modal. The admission gate is driven by the
  // window's open/close (setPairing), NOT by this call.
  ipcMain.handle("sidecode:getPairOffer", () => {
    if (!daemon) throw new Error("daemon not ready");
    return daemon.createPairOffer(hostname());
  });

  // Tray icon: a monochrome template image (black + alpha). macOS ignores the
  // RGB and tints via the alpha mask — dark glyph on light menu bars, light on
  // dark, auto-inverted on highlight. createFromPath auto-pairs the @2x file and
  // honors the `Template` filename suffix; setTemplateImage is an explicit guard.
  const trayIcon = nativeImage.createFromPath(
    path.join(import.meta.dirname, "../assets/iconTemplate.png"),
  );
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  // Order matters: kick the async usage refresh FIRST (lands by the next
  // open), then rebuild synchronously so this open gets the latest cached
  // snapshot.
  const onTrayOpen = () => {
    refreshPlanUsage();
    refreshMenu();
  };
  tray.on("click", onTrayOpen);
  tray.on("right-click", onTrayOpen);

  refreshPlanUsage();
  refreshMenu();
  // Keep the cached snapshot warm independent of tray opens, so the next
  // open paints current data instead of the previous open's (NSMenu can't
  // repaint while open). Cleared in before-quit.
  planUsageTimer = setInterval(refreshPlanUsage, PLAN_USAGE_POLL_MS);
  console.log("[main] tray + menu ready");

  // electron-updater: auto-download + drive the update menu items. Rebuilds the
  // menu on every state change so the row reflects checking/downloading/ready.
  initUpdater({ onStateChange: refreshMenu });
});

app.on("before-quit", (event: Electron.Event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
  if (planUsageTimer) clearInterval(planUsageTimer);
  console.log("[main] before-quit: stopping daemon...");
  const stopPromise = daemon ? daemon.stop() : Promise.resolve();
  void stopPromise.then(() => {
    console.log("[main] daemon stopped, quitting");
    app.quit();
  });
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[main] received ${sig}`);
    app.quit();
  });
}
