import type { ElectrobunConfig } from "electrobun";

// The CLI evaluates this file for BOTH `electrobun dev` and
// `electrobun build --env=...`; argv tells them apart. The two modes want
// different bundling:
//
//  dev      — daemon stays EXTERNAL and resolves through the repo's
//             node_modules (workspace symlink → packages/daemon/dist), so a
//             daemon rebuild is picked up without re-bundling the desktop.
//  packaged — there is no repo at runtime, so the daemon (+protocol +SDK JS)
//             is BUNDLED into the bun entry; only node-datachannel stays
//             external (native .node prebuild can't inline) and is staged
//             into app/bun/node_modules by `copy`, where the bundle's
//             import("node-datachannel/polyfill") resolves it by walk-up.
//             The renderer dist and tray icon ride along under views/.
//             The SDK's 230MB platform claude binary is deliberately NOT
//             shipped — packaged builds discover the SYSTEM claude (version
//             gate in server/index.ts).
const packaged = process.argv.includes("build");

// Sign/notarize exactly when credentials are present (the package script
// sources .env.local before invoking the CLI, so this config sees them).
// Without credentials a packaged build still succeeds — unsigned, for
// local testing; downloaded unsigned apps need `xattr -cr` to open.
const canSign = packaged && !!process.env.ELECTROBUN_DEVELOPER_ID;
const canNotarize =
  canSign &&
  !!(process.env.ELECTROBUN_APPLEIDPASS || process.env.ELECTROBUN_APPLEAPIKEY);

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
      external: packaged
        ? ["node-datachannel", "node-datachannel/polyfill"]
        : ["@sidecodeapp/daemon"],
    },
    ...(packaged
      ? {
          copy: {
            dist: "views/dist",
            "assets/tray.png": "views/assets/tray.png",
            "../../node_modules/node-datachannel":
              "bun/node_modules/node-datachannel",
          },
        }
      : {}),
    // Default entitlements already carry the bun-JIT trio (allow-jit,
    // unsigned-executable-memory, disable-library-validation) — no custom
    // entitlements file needed for a signed hardened runtime.
    mac: { bundleCEF: false, codesign: canSign, notarize: canNotarize },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;
