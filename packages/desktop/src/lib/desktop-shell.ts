import type { CSSProperties } from "react";

// Electron-shell detection + native drag-region style, shared by every
// surface that renders under a hiddenInset window (__root's strip, the
// pair window). In a plain browser tab (vite dev) the UA flag is absent
// and consumers render nothing.
export const isDesktopShell =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

// Chromium's native app-region CSS — preventDefaults drags properly, so no
// select-none dance (that was an electrobun-polyfill artifact).
export const DRAG_REGION = { WebkitAppRegion: "drag" } as CSSProperties;
