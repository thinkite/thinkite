const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const config = getDefaultConfig(__dirname);

// Key Metro's transform cache by project root. @expo/metro-config stores the
// cache in a GLOBAL $TMPDIR/metro-cache, and expo-dom's generated entry proxy
// (node_modules/expo/dom/entry.js) embeds the DOM component's ABSOLUTE path
// without hashing it into the cache key — so two checkouts of this app (e.g.
// consecutive `eas build --local` runs, each in a fresh temp dir) poison each
// other and eager-bundle fails with "Unable to resolve ../<old-build-id>/...".
// Mixing the root into cacheVersion makes every checkout's entries distinct.
config.cacheVersion = __dirname;

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
