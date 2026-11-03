// Builds Pierre's highlight worker into assets/pierre/worker-portable.pwt so
// Metro serves it as a fetchable asset (the DOM webview fetches its URI →
// Blob → `new Worker`). The `.pwt` extension keeps Metro from bundling it as
// a JS module.
//
// Pierre publishes this worker prebuilt (worker-portable.js), but with its
// shiki backend inlined: shiki's engines and the oniguruma wasm, parsed on
// every worker start though the pool only runs highlights. So this bundles
// @pierre/diffs/worker/worker.js into one file the way Pierre's own build
// does (`__DIFFS_WORKER__`, no code splitting), with shiki swapped for the
// stub metro.config.js uses for the DOM bundle.
//
// Run after install / before bundling: `bun scripts/sync-pierre-worker.mjs`.
// The artifact is gitignored; this script regenerates it.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, "..", "pierre-shiki-stub.js");

// @pierre/diffs is ESM-only (exports define only the `import` condition), so a
// CJS require.resolve can't find it — use ESM import.meta.resolve.
const entry = fileURLToPath(
  import.meta.resolve("@pierre/diffs/worker/worker.js"),
);

// worker.js re-exports internals for Pierre's split chunks; an entry that only
// imports it leaves no `export` in the output, so `new Worker(blobUrl)` can
// load it as a classic script.
const ENTRY = "pierre-worker-entry";
const result = await Bun.build({
  entrypoints: [ENTRY],
  target: "browser",
  format: "esm",
  splitting: false,
  minify: true,
  define: { __DIFFS_WORKER__: "true" },
  plugins: [
    {
      name: "strip-pierre-shiki",
      setup(build) {
        build.onResolve({ filter: /^pierre-worker-entry$/ }, () => ({
          path: ENTRY,
          namespace: "pierre-worker",
        }));
        build.onLoad({ filter: /.*/, namespace: "pierre-worker" }, () => ({
          contents: `import ${JSON.stringify(entry)};`,
          loader: "js",
        }));
        build.onResolve(
          {
            filter:
              /^(\.\/shiki-[\w-]+\.js|shiki(\/.*)?|@shikijs\/.*|@pierre\/theming\/themes)$/,
          },
          (args) =>
            args.importer.includes("/@pierre/diffs/dist/")
              ? { path: stub }
              : undefined,
        );
      },
    },
  ],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
const [output] = result.outputs;
const destDir = join(here, "..", "assets", "pierre");
const dest = join(destDir, "worker-portable.pwt");
mkdirSync(destDir, { recursive: true });
writeFileSync(dest, await output.text());
console.log(
  `[sync-pierre-worker] ${entry} -> ${dest} (${(output.size / 1024).toFixed(0)} KB)`,
);
