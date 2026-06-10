// electron-builder config. CJS (.cjs) on purpose: this package is type:module,
// so a plain .js would load as ESM — .cjs keeps it unambiguous CommonJS.
//
// Signing is auto-discovered from the keychain (the Developer ID Application
// cert) — no `identity` pin, so a machine without the cert just builds unsigned
// (warns) instead of failing. Notarization is GATED on the App Store Connect
// API-key env so quick local `package:mac` builds stay fast (sign-only) and only
// the release path (env set) uploads to Apple's notary. Same script, env decides.
const notarize = Boolean(process.env.APPLE_API_KEY);

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "app.sidecode.menubar",
  productName: "Sidecode",
  directories: {
    // CRITICAL: vite emits the renderer to dist/. electron-builder's default
    // output is also `dist` and it WIPES the output dir first — send artifacts
    // to release/ instead. buildResources defaults to build/ (icon.icns +
    // entitlements.mac.plist live there).
    output: "release",
    buildResources: "build",
  },
  // Production node_modules are collected automatically; this filter scopes app
  // source. The SDK's per-platform `claude` SEA binary (~212MB) IS bundled —
  // sidecode spawns it (Desktop-style) instead of resolving a system claude,
  // feeding it the keychain OAuth token via env (see daemon bridge/credentials).
  files: ["dist/**/*", "dist-electron/**/*", "assets/**/*", "package.json"],
  asar: true,
  // Executables can't run from inside the asar archive:
  //  - node-datachannel ships a prebuilt .node (must be dlopen-able)
  //  - the claude SEA binary must be spawnable
  asarUnpack: [
    "**/node_modules/node-datachannel/**",
    "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
  ],
  // node-datachannel is prebuilt; don't rebuild native modules against Electron.
  npmRebuild: false,
  mac: {
    category: "public.app-category.developer-tools",
    target: [
      { target: "dmg", arch: ["arm64"] },
      { target: "zip", arch: ["arm64"] }, // required by electron-updater
    ],
    artifactName: "${productName}-${version}-${arch}.${ext}",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    // Menu bar agent: no Dock icon / Cmd-Tab entry. Pairs with app.dock.hide().
    extendInfo: { LSUIElement: true },
    // true only when ASC API-key env is present (APPLE_API_KEY / _KEY_ID /
    // _ISSUER); electron-builder reads those automatically. macOS auto-update
    // (Squirrel.Mac) requires a signed AND notarized build to install.
    notarize,
  },
  // electron-updater feed. Generic = any static host; generating this makes the
  // build emit latest-mac.yml + .blockmap (differential updates). The packaged
  // app's embedded app-update.yml bakes in whatever url is set at BUILD time.
  // SIDECODE_UPDATE_URL overrides the feed at build time (e.g. point a test
  // build at a local static server); otherwise the real R2 host (TODO).
  publish: {
    provider: "generic",
    url:
      process.env.SIDECODE_UPDATE_URL || "https://REPLACE_WITH_R2_PUBLIC_URL",
    channel: "latest",
  },
};
