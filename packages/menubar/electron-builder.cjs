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
  //
  // Two electron-builder build warnings are EXPECTED with this setup:
  //  - "platform-specific optional dependencies not bundled" (darwin-x64 /
  //    linux-* / win32-* SDK binaries): pnpm installs only the host platform's
  //    binary and V0 ships arm64-mac only — darwin-arm64 IS bundled, the rest
  //    are intentionally absent. Revisit only if we ever add an x64 target.
  //  - "duplicate dependency references": pnpm's nested layout makes some deps
  //    reachable via multiple paths (menubar → daemon link → shared deps);
  //    informational, worst case a few duplicated JS copies in the asar —
  //    noise next to the 212MB SEA binary.
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
  // electron-updater feed. The packaged app's embedded app-update.yml bakes in
  // whatever is set at BUILD time:
  //  - default: GitHub Releases (latest-mac.yml + .blockmap published as release
  //    assets; electron-updater polls the latest PUBLISHED release anonymously —
  //    this is why drafts are the release pipeline's safety gate).
  //  - SIDECODE_UPDATE_URL: generic-provider override for pointing a local test
  //    build at a static server (e.g. `npx serve release/`).
  // `releaseType: "draft"` means CI's `--publish always` creates a DRAFT release;
  // installed apps only see it once it's manually published.
  publish: process.env.SIDECODE_UPDATE_URL
    ? {
        provider: "generic",
        url: process.env.SIDECODE_UPDATE_URL,
        channel: "latest",
      }
    : {
        provider: "github",
        owner: "thinkite",
        repo: "thinkite",
        releaseType: "draft",
      },
};
