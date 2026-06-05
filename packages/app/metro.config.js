const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

// Follow symlinks so Metro resolves the pnpm-linked workspace packages
// (`@sidecodeapp/protocol`, etc.).
config.resolver.unstable_enableSymlinks = true;

// Pierre's off-thread highlight worker (worker-portable.js) is vendored into
// assets/ with a `.pwt` extension so Metro serves it as a fetchable ASSET (not a
// JS module to bundle). The DOM webview fetches its URI → Blob → `new Worker`.
// See scripts/sync-pierre-worker.mjs.
config.resolver.assetExts.push("pwt");

module.exports = withUniwindConfig(config, {
  // relative path to your global.css file (from previous step)
  cssEntryFile: "./src/global.css",
  // (optional) path where we gonna auto-generate typings
  // defaults to project's root
  dtsFile: "./src/uniwind-types.d.ts",
});
