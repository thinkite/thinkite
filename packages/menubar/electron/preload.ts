import { contextBridge, ipcRenderer } from "electron";

/**
 * Minimal renderer ↔ main bridge for the Pair window. The tray menu is a
 * native NSMenu running entirely in main, so this is currently the only
 * IPC channel — bumping it to `expose` style instead of full Node access
 * keeps the renderer sandboxed (`contextIsolation: true`).
 *
 * `getPairOffer()` asks main to mint the pair offer via the daemon's
 * `createPairOffer()`. Pure on the daemon side (same daemon → same offer),
 * so PairView calls it once. The admission gate is driven by the Pair
 * window's open/close in main (daemon.setPairing), NOT by this call.
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
