import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import electron from "vite-plugin-electron/simple";

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
          build: { rolldownOptions: { external: ["electron"] } },
        },
      },
      preload: {
        input: "electron/preload.ts",
      },
    }),
  ],
});
