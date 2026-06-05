// Copies Pierre's self-contained highlight worker (worker-portable.js) out of
// node_modules into assets/pierre/worker-portable.pwt so Metro serves it as a
// fetchable asset (the DOM webview fetches its URI → Blob → `new Worker`).
// The `.pwt` extension keeps Metro from bundling it as a JS module.
//
// Run after install / before bundling: `node scripts/sync-pierre-worker.mjs`.
// The artifact is gitignored; this script regenerates it.
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// @pierre/diffs is ESM-only (exports define only the `import` condition), so a
// CJS require.resolve can't find it — use ESM import.meta.resolve.
const src = fileURLToPath(
  import.meta.resolve("@pierre/diffs/worker/worker-portable.js"),
);
const destDir = join(here, "..", "assets", "pierre");
const dest = join(destDir, "worker-portable.pwt");

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log(`[sync-pierre-worker] ${src} -> ${dest}`);
