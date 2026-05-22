import { contextBridge, ipcRenderer } from "electron";

/**
 * Minimal renderer ↔ main bridge for the Pair window. The tray menu is a
 * native NSMenu running entirely in main, so this is currently the only
 * IPC channel — bumping it to `expose` style instead of full Node access
 * keeps the renderer sandboxed (`contextIsolation: true`).
 *
 * `getPairOffer()` asks main to mint a fresh pair offer via the daemon's
 * `createPairOffer()`. Pure on the daemon side; calling it ALSO extends
 * the auto-tracked "pair window open" admission window in the daemon, so
 * the renderer's periodic refresh (PairView ticks every 2.5min) keeps
 * unknown pubkeys admittable as long as the window is visible.
 */
contextBridge.exposeInMainWorld("sidecode", {
  getPairOffer: (): Promise<{ encoded: string }> =>
    ipcRenderer.invoke("sidecode:getPairOffer"),
});

declare global {
  interface Window {
    sidecode: {
      getPairOffer(): Promise<{ encoded: string }>;
    };
  }
}
