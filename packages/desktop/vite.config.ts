import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";

export default defineConfig(({ command }) => ({
  plugins: [
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    // The workspace hoists one react (pinned by the Expo app) while Astryx's
    // peer range can pull a nested copy — two React instances break hooks
    // (`p.H.use` TypeError in Theme). Always bundle exactly one.
    dedupe: ["react", "react-dom"],
    // astryx 0.1.5's published dist is compiled with the DEV jsx transform;
    // react's production jsx-dev-runtime exports `jsxDEV = undefined`, so
    // built bundles crash at module eval (blank #root). Build-only: the dev
    // server resolves the development condition and works, and our own
    // sources should keep real dev-runtime diagnostics there. See the shim
    // for the full story; drop both when astryx ships a fixed build.
    alias:
      command === "build"
        ? {
            "react/jsx-dev-runtime": new URL(
              "./src/lib/jsx-dev-runtime-prod-shim.ts",
              import.meta.url,
            ).pathname,
          }
        : undefined,
  },
  // Pierre's worker.js is an ES module — the official docs call out that
  // Vite's `?worker` build needs format "es" (the iife default can't wrap
  // module workers). WKWebView-only target, so es is always safe.
  worker: { format: "es" },
  // Prebundle Pierre's entries (incl. the ?worker subpath) — t3code's setup;
  // avoids dev-time optimizer misses on the multi-entry exports map.
  optimizeDeps: {
    include: ["@pierre/diffs", "@pierre/diffs/react"],
  },
  server: {
    port: 5183,
    strictPort: true,
    // Vite-HMR dev mode: the webview's origin is this dev server; backend
    // routes live on the Deno side, whose port the desktop runtime chooses
    // at random (it ignores Deno.serve's `port` option). main.ts passes the
    // real address via SIDECODE_PTY_TARGET when it spawns us (`pnpm dev`).
    proxy: {
      "/pty": {
        target: process.env.SIDECODE_PTY_TARGET ?? "http://localhost:5184",
        ws: true,
      },
      "/rpc": {
        target: process.env.SIDECODE_PTY_TARGET ?? "http://localhost:5184",
        ws: true,
      },
      "/api": {
        target: process.env.SIDECODE_PTY_TARGET ?? "http://localhost:5184",
      },
    },
  },
}));
