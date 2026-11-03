const path = require("node:path");
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

// Pierre diffs ships two highlighter backends and picks one at runtime with
// dynamic imports. pierre-view.tsx runs `preferredHighlighter: "highlights"`,
// so the shiki backend never loads — but Metro still bundled it into the DOM
// component's www.bundle with every shiki grammar and theme (242 of 325
// files, ~10.8 of 13.3 MB), and hoisted the grammars several languages embed
// into the __common chunk the webview loads at startup (3.85 MB, all shiki).
// For the web (DOM component) bundle only, the shiki backend, its TextMate
// theme catalog and any shiki import from inside diffs resolve to a module
// that fails on import. The worker is built the same way by
// scripts/sync-pierre-worker.mjs.
const PIERRE_SHIKI_STUB = path.join(__dirname, "pierre-shiki-stub.js");
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (
    platform === "web" &&
    context.originModulePath.includes("/@pierre/diffs/dist/") &&
    (moduleName === "./backends/shiki.js" ||
      moduleName === "@pierre/theming/themes" ||
      /^(shiki|@shikijs\/)/.test(moduleName))
  ) {
    return { type: "sourceFile", filePath: PIERRE_SHIKI_STUB };
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = withUniwindConfig(config, {
  // relative path to your global.css file (from previous step)
  cssEntryFile: "./src/global.css",
  // (optional) path where we gonna auto-generate typings
  // defaults to project's root
  dtsFile: "./src/uniwind-types.d.ts",
});
