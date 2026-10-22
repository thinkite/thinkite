import type { CSSProperties } from "react";

// Electron-shell detection + native drag-region style, shared by every
// surface that renders under a hiddenInset window. In a plain browser tab
// (vite dev) the UA flag is absent and nothing drags.
export const isDesktopShell =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

// The main window drags by its chrome rows, after DeepSeek Harness's window
// drag contract: a row marks itself `data-window-drag` and its own box is
// the drag geometry, so no fixed band has to match any row's height; one
// rule in styles.css (under `html[data-desktop-shell]`) turns the marks on
// and takes every control back out.
if (isDesktopShell) document.documentElement.dataset.desktopShell = "";

// Chromium's native app-region CSS — preventDefaults drags properly, so no
// select-none dance (that was an electrobun-polyfill artifact). The pair
// window's fixed strip still uses it inline.
export const DRAG_REGION = { WebkitAppRegion: "drag" } as CSSProperties;
