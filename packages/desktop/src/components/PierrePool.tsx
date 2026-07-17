import type { SupportedLanguages } from "@pierre/diffs";
import { useWorkerPool, WorkerPoolContextProvider } from "@pierre/diffs/react";
import PierreWorker from "@pierre/diffs/worker/worker.js?worker";
import { type ReactNode, useEffect, useMemo } from "react";

// Shared Pierre highlight worker pool, mounted ONCE at the app root
// (__root.tsx) and EXPLICITLY initialized on mount. Two subtleties, both
// verified in Pierre's source:
//  - Mounting WorkerPoolContextProvider alone warms nothing — it only creates
//    the manager singleton; the expensive `initialize()` (spawn N workers,
//    load the shiki engine + every grammar into EACH worker, resolve themes)
//    is normally deferred until the first File/FileDiff render. Without the
//    warmup that boot ran on first Diff-tab open and showed as seconds of
//    plain text before colors arrived. (Pierre paints plain first and
//    colorizes when workers answer BY DESIGN — warmup only removes the boot
//    from the visible path.)
//  - The pool is a refcounted module singleton: the last provider unmounting
//    TERMINATES the workers. Per-route mounting would cold-boot on every
//    route revisit; at the root it initializes once per app launch, and every
//    diff surface (session Diff tab, P2 transcript tool-call diffs) shares it.

// Preloaded grammars, same set the iOS PierreView ships. Files outside the
// list fall back to plain text.
const LANGS: SupportedLanguages[] = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "css",
  "html",
  "markdown",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "shellscript",
  "yaml",
  "toml",
  "ruby",
  "swift",
  "sql",
];

function PoolWarmup() {
  const pool = useWorkerPool();
  useEffect(() => {
    // Idempotent: initialize() returns the in-flight/settled promise on
    // repeat calls. Failure just means the lazy path runs later instead.
    void pool?.initialize(LANGS).catch(() => {});
  }, [pool]);
  return null;
}

export function PierrePool({ children }: { children: ReactNode }) {
  const poolOptions = useMemo(
    () => ({
      workerFactory: () => new PierreWorker(),
      // t3code's sizing: half the cores, clamped 2–6.
      poolSize: Math.max(
        2,
        Math.min(6, Math.floor((navigator.hardwareConcurrency || 4) / 2)),
      ),
    }),
    [],
  );
  const highlighterOptions = useMemo(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" } as const,
      langs: LANGS,
      // shiki-js (JS regex engine), NOT shiki-wasm: on V8 the JS engine is
      // fast, and it avoids oniguruma's grow-only wasm linear memory
      // (~40-150M per worker once hot, never returned — wasm memory can't
      // shrink). The wasm engine was a WKWebView-era necessity: shiki-js
      // ran ~5x slower on JSC, which is why iOS's PierreView still ships
      // shiki-wasm. Electron renderer = Chromium/V8, so desktop flips.
      preferredHighlighter: "shiki-js" as const,
      // Skip tokenizing pathological lines (lock files, minified bundles) —
      // they render plain instead of stalling the worker (t3code's guard).
      tokenizeMaxLineLength: 1_000,
    }),
    [],
  );
  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={highlighterOptions}
    >
      <PoolWarmup />
      {children}
    </WorkerPoolContextProvider>
  );
}
