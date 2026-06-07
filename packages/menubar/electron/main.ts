import { hostname } from "node:os";
import path from "node:path";
import { type Daemon, start as startDaemon } from "@sidecodeapp/daemon";
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

let tray: Tray | null = null;
let pairWindow: BrowserWindow | null = null;
let isQuitting = false;
let daemon: Daemon | null = null;
let keepAwakeId: number | null = null;

// --- Mock data (replace with real fetches before V0 ship) ---

const MOCK_PLAN_USAGE = {
  fiveHour: { utilization: 0.91, resetsAt: nowPlus(6 * 3600 + 31 * 60) },
  sevenDay: { utilization: 0.99, resetsAt: nowPlus(7 * 86400) },
  sevenDayOpus: { utilization: 0.45 },
  sevenDaySonnet: { utilization: 0.99 },
};

const MOCK_USAGE_STATS = {
  allTime: { tokens: 3_200_000 },
  last7d: { tokens: 850_000 },
  last30d: { tokens: 2_100_000 },
};

const MOCK_UPDATE_AVAILABLE = true;
const MOCK_UPDATE_VERSION = "1.2.0";

function nowPlus(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// --- Formatters ---

function formatPercent(util: number): string {
  return `${Math.round(util * 100)}%`;
}

function formatCountdown(resetsAt: string): string {
  const ms = new Date(resetsAt).getTime() - Date.now();
  if (ms <= 0) return "0:00";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}:${m.toString().padStart(2, "0")}`;
}

function formatResetDate(resetsAt: string): string {
  const d = new Date(resetsAt);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

function formatUsageLine(tokens: number): string {
  return formatTokens(tokens);
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

function buildMenu(): Electron.Menu {
  const plan = MOCK_PLAN_USAGE;
  const usage = MOCK_USAGE_STATS;

  const items: Electron.MenuItemConstructorOptions[] = [
    { label: "Claude Plan Usage", type: "header" },
    {
      label: `5h - ${formatPercent(plan.fiveHour.utilization)} · ${formatCountdown(plan.fiveHour.resetsAt)}`,
      enabled: false,
    },
    {
      label: `Weekly - ${formatPercent(plan.sevenDay.utilization)} · ${formatResetDate(plan.sevenDay.resetsAt)}`,
      enabled: false,
    },
    {
      label: `Opus - ${formatPercent(plan.sevenDayOpus.utilization)}`,
      enabled: false,
    },
    {
      label: `Sonnet - ${formatPercent(plan.sevenDaySonnet.utilization)}`,
      enabled: false,
    },
    { type: "separator" },
    { label: "Token Stats", type: "header" },
    {
      label: `All - ${formatUsageLine(usage.allTime.tokens)}`,
      enabled: false,
    },
    {
      label: `7d - ${formatUsageLine(usage.last7d.tokens)}`,
      enabled: false,
    },
    {
      label: `30d - ${formatUsageLine(usage.last30d.tokens)}`,
      enabled: false,
    },
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

  if (MOCK_UPDATE_AVAILABLE) {
    items.push({
      label: `Update v${MOCK_UPDATE_VERSION} · Install`,
      icon: symbolIcon("arrow.up.circle"),
      click: () => {
        console.log("[main] update install clicked (mock)");
      },
    });
  }

  items.push(
    {
      label: "About sidecode",
      icon: symbolIcon("info.circle"),
      submenu: [
        { label: `Version ${app.getVersion()}`, enabled: false },
        {
          label: "Check for updates",
          click: () => {
            console.log("[main] check for updates clicked (mock)");
          },
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

  const trayImage = nativeImage.createEmpty();
  tray = new Tray(trayImage);
  tray.setTitle("◉ sc");
  tray.on("click", refreshMenu);
  tray.on("right-click", refreshMenu);

  refreshMenu();
  console.log("[main] tray + menu ready");
});

app.on("before-quit", (event: Electron.Event) => {
  if (isQuitting) return;
  event.preventDefault();
  isQuitting = true;
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
