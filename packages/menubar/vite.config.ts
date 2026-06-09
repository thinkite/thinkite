import path from "node:path";
import tailwind from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import electron from "vite-plugin-electron/simple";
import pkg from "./package.json" with { type: "json" };

// Anything resolved through `dependencies` is left as a runtime
// `require()` instead of being inlined into main.js. Native modules
// (node-datachannel ships a .node binary via a relative path inside
// its own package) must NOT be bundled — Rolldown rewrites the
// require path and the .node file can't be found. External-by-name
// is also fine for pure-JS deps since pnpm hoisted nodeLinker puts
// them at a path Node can resolve from dist-electron/main.js.
const externalDeps = Object.keys(pkg.dependencies ?? {});

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
    dedupe: ["react", "react-dom"],
  },
  plugins: [
    react(),
    tailwind(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            rolldownOptions: { external: ["electron", ...externalDeps] },
          },
        },
      },
      preload: {
        input: "electron/preload.ts",
      },
    }),
  ],
});
