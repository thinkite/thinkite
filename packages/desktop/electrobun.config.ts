import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "Sidecode",
    identifier: "app.sidecode.desktop",
    version: "0.0.1",
  },
  runtime: {
    // Windows may all REALLY close; the app keeps running for the tray/dock
    // until explicit quit (tray Quit — Cmd+Q also routes through the app
    // lifecycle here, unlike laufey's native [NSApp terminate:]).
    exitOnLastWindowClosed: false,
  },
  build: {
    bun: {
      // MUST compile to app/bun/index.js: the host Resources/main.js
      // hardcodes `join(appFolderPath, "bun", "index.js")` for its Worker
      // and a differently-named entry fails SILENTLY (worker never starts,
      // no error). So the entry file must be named index.ts regardless of
      // what this field says. Upstream candidate: use the configured name.
      entrypoint: "server/index.ts",
      // Resolved at RUNTIME from the repo's node_modules (workspace symlink
      // → packages/daemon/dist): bundling it would inline the daemon's lazy
      // node-datachannel loader away from where the N-API prebuild lives.
      external: ["@sidecodeapp/daemon"],
    },
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
