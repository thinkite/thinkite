import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.{test,spec}.ts",
      // Electron-main code (no Electron window needed for these): the
      // `/oc` proxy handler + its gated live E2E.
      "packages/desktop/server/**/*.{test,spec}.ts",
    ],
    environment: "node",
  },
});
