import { contextBridge, ipcRenderer } from "electron";

/**
 * Minimal renderer ↔ main bridge for the Pair window. The tray menu is a
 * native NSMenu running entirely in main, so this is currently the only
 * IPC channel — bumping it to `expose` style instead of full Node access
 * keeps the renderer sandboxed (`contextIsolation: true`).
 *
 * `getPairOffer()` asks main to mint a fresh pair offer via the daemon's
 * `createPairOffer()`. Stateless on the daemon side, so the renderer can
 * call it on mount and again on the rotation cadence (PairView ticks
 * every TTL/2) without coordination.
 */
contextBridge.exposeInMainWorld("sidecode", {
  getPairOffer: (): Promise<{ encoded: string; expiresAt: number }> =>
    ipcRenderer.invoke("sidecode:getPairOffer"),
});

declare global {
  interface Window {
    sidecode: {
      getPairOffer(): Promise<{ encoded: string; expiresAt: number }>;
    };
  }
}
