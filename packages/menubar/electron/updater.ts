import { app } from "electron";
// electron-updater is CJS; default-import + destructure is the safe ESM interop.
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

/**
 * Update lifecycle as the menu renders it. autoDownload is on, so an available
 * update goes straight to "downloading"; "downloaded" is the only actionable
 * state (click → quitAndInstall). idle/error show no prominent item — the
 * manual "Check for updates" in the About submenu covers re-checking.
 */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

let state: UpdateState = { status: "idle" };
// download-progress events carry no version; remember it from update-available.
let pendingVersion = "";
let onChange: (() => void) | null = null;

export function getUpdateState(): UpdateState {
  return state;
}

export function initUpdater(opts: { onStateChange: () => void }): void {
  // Auto-update only runs in packaged builds — Squirrel.Mac needs the installed
  // .app, and the feed is the embedded app-update.yml (from electron-builder.cjs
  // publish.url). In dev it's inert; test via a packaged build pointed at a feed
  // with SIDECODE_UPDATE_URL.
  if (!app.isPackaged) return;
  onChange = opts.onStateChange;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // silently apply on next quit (default)

  autoUpdater.on("checking-for-update", () => set({ status: "checking" }));
  autoUpdater.on("update-available", (info) => {
    pendingVersion = info.version;
    set({ status: "downloading", version: info.version, percent: 0 });
  });
  autoUpdater.on("update-not-available", () => set({ status: "idle" }));
  autoUpdater.on("download-progress", (p) =>
    set({
      status: "downloading",
      version: pendingVersion,
      percent: Math.round(p.percent),
    }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    set({ status: "downloaded", version: info.version }),
  );
  autoUpdater.on("error", (err) =>
    set({ status: "error", message: err?.message ?? String(err) }),
  );

  checkForUpdates();
}

export function checkForUpdates(): void {
  // Failures also fire the "error" event; this catch just prevents an unhandled
  // rejection when no feed is reachable (e.g. dev without a real dev-app-update.yml).
  autoUpdater.checkForUpdates().catch((err) => {
    console.warn(
      `[updater] check failed: ${err instanceof Error ? err.message : err}`,
    );
  });
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}

function set(next: UpdateState): void {
  state = next;
  onChange?.();
}
