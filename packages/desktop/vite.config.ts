import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
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
    // routes live on server/index.ts's Bun.serve at its FIXED port (it
    // probes us at 5183 by the same convention — no env relay either way).
    proxy: {
      "/pty": { target: "http://127.0.0.1:5199", ws: true },
      "/rpc": { target: "http://127.0.0.1:5199", ws: true },
      "/api": { target: "http://127.0.0.1:5199" },
    },
  },
});
