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
  productName: "sidecode",
  directories: {
    // CRITICAL: vite emits the renderer to dist/. electron-builder's default
    // output is also `dist` and it WIPES the output dir first — send artifacts
    // to release/ instead. buildResources defaults to build/ (icon.icns +
    // entitlements.mac.plist live there).
    output: "release",
    buildResources: "build",
  },
  // Production node_modules are collected automatically; this filter scopes app
  // source. We spawn the user's SYSTEM claude (daemon passes
  // pathToClaudeCodeExecutable), so the SDK's bundled per-platform `claude`
  // binary (~205MB) is dead weight — drop it (dmg ~178MB → ~118MB). The main
  // @anthropic-ai/claude-agent-sdk JS package is kept.
  files: [
    "dist/**/*",
    "dist-electron/**/*",
    "assets/**/*",
    "package.json",
    "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
  ],
  asar: true,
  // node-datachannel ships a prebuilt .node — must live OUTSIDE the asar to be
  // dlopen-able. It's the only native runtime module in the dep tree.
  asarUnpack: ["**/node_modules/node-datachannel/**"],
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
  // SIDECODE_UPDATE_URL lets a local build point at the test feed
  // (http://localhost:8788, `pnpm feed`); otherwise the real R2 host (TODO).
  publish: {
    provider: "generic",
    url: process.env.SIDECODE_UPDATE_URL || "https://REPLACE_WITH_R2_PUBLIC_URL",
    channel: "latest",
  },
};
