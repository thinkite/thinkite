"use dom";

import {
  isHighlighterLoaded,
  parsePatchFiles,
  type SupportedLanguages,
} from "@pierre/diffs";
import {
  CodeView,
  File,
  PatchDiff,
  type PostRenderPhase,
  WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import type { DOMProps } from "expo/dom";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { JETBRAINS_MONO_CSS } from "./jetbrains-mono-font";

/**
 * Tool-detail renderer: `@pierre/diffs` (shiki) inside an `@expo/dom-webview`
 * WebView. Replaces the react-native-diffs (`DiffsView` / `MarkdownView`) path
 * for `bash` / `read` / `edit` / `write` / `grep` / `glob` detail bodies.
 *
 * `"use dom"` makes Metro bundle this subtree as a web bundle (needs react-dom +
 * react-native-web) that runs inside the already-built `@expo/dom-webview`
 * native view — no react-native-webview, no native rebuild.
 *
 * Hosted as a SINGLE resident, pre-warmed instance in `tool-call-sheet.tsx`:
 * the sheet keeps it mounted across opens (SWM bottom-sheet keeps collapsed
 * children mounted), so shiki stays warm and opens are fast. `onReady` gates
 * the sheet open until the new payload has painted (no flash of the previous
 * one); `collapsed` scrolls back to top when the sheet closes (the resident
 * webview otherwise keeps the prior payload's scroll position).
 *
 * IMPORTANT — `content` MUST arrive `encodeURIComponent`-encoded. `@expo/dom-
 * webview@56.0.4` injects the initialProps JSON inside a JS *template literal*
 * (DomWebView.swift `setInjectedJavaScriptObject`), so any backslash escape in
 * a prop value (a newline → `\n`, a backtick, `${`) is re-interpreted and
 * corrupts the JSON → "Unterminated string" → the DOM runtime never boots
 * (blank webview, no error). Encoded text has no `\` / backtick / newline /
 * quote, so it survives the round-trip; we decode here.
 */
const CSS = `
${JETBRAINS_MONO_CSS}
/* --diffs-font-family inherits across the shadow boundary into Pierre; the
   embedded @font-face is document-global so the shadow can use it. */
:root { --diffs-font-family: "JetBrains Mono", ui-monospace, monospace; }
/* expo's DOM scaffold claims to make the body full-height but only sets
   -webkit-overflow-scrolling — html/body get NO height and body is not a flex
   container, so #root's {flex:1} is inert and #root sizes to its content. That
   makes CodeView (which uses root.getBoundingClientRect().height as its scroll
   VIEWPORT) measure the full content height → it windows nothing and renders
   every line. Bind the whole chain to the viewport so CodeView gets a fixed
   viewport and actually virtualizes. */
:root, html, body { margin: 0; padding: 0; background: transparent; height: 100%; }
/* expo-dom sets #root { display:flex; flex:1 } which defaults to row — stack,
   and give it the viewport height the broken flex:1 didn't. */
#root { flex-direction: column; align-items: stretch; height: 100%; }
`;

// Open anyway if the highlighter never loads, so a wedged shiki can't hang the
// sheet open. onPostRender (below) is the fast path; this is only a backstop.
const FALLBACK_MS = 4000;

export interface PierreViewProps {
  /** "diff" = single-file patch (PatchDiff), "code" = single file (File),
   *  "multifile" = a raw multi-file `git diff` (CodeView, one section per file —
   *  used by the working-tree diff). */
  kind: "diff" | "code" | "multifile";
  /** encodeURIComponent-encoded (see @expo/dom-webview bug note above). */
  content: string;
  /** filename — drives shiki language inference for kind="code". Still used
   *  for language even when the header is hidden. */
  name?: string;
  scheme: "light" | "dark";
  /** Hide Pierre's filename-header bar. Set for command/search output (bash,
   *  grep, glob) where the synthetic name ("command.sh") reads as noise; left
   *  on for real files (read) and diffs (edit/write). */
  disableFileHeader?: boolean;
  /** Hide the left line-number gutter. Set for command/search output (bash,
   *  grep, glob) — terminal/results text isn't line-addressable, and grep's own
   *  `file:line:` prefixes would double up. Left on for real files / diffs. */
  disableLineNumbers?: boolean;
  /** Marshalled to RN once the highlighter loaded + content painted (TTI end);
   *  the sheet opens (or warm-marks) from this. */
  onReady?: () => void;
  /** True while the host sheet is collapsed/closed. PierreView scrolls back to
   *  the top whenever it collapses — done while hidden, so reopening (warm reuse,
   *  button-close, or drag-dismiss) always starts at the top with no scroll jump
   *  on the way in. (A live diff refetch keeps the sheet open, so it won't yank
   *  scroll; and the backdrop blocks switching content without closing first.) */
  collapsed?: boolean;
  /** Bottom safe-area inset in px (from RN useSafeAreaInsets). Added to the
   *  multi-file CodeView's bottom layout padding so its last line clears the
   *  home indicator. Single-file File/PatchDiff get an equivalent inset for free
   *  from WKWebView's automatic content inset on the document scroll; CodeView's
   *  internal CSS scroll container doesn't, so we add it explicitly. */
  bottomInset?: number;
  /** Fetchable URL of Pierre's `worker-portable.js` (a Metro asset, passed from
   *  RN). PierreView fetches it → Blob → `new Worker` to run shiki highlighting
   *  off the main thread (Pierre's VS Code-webview worker-pool pattern) so
   *  tokenization doesn't block scroll. Until it loads, highlighting runs on the
   *  main thread (disableWorkerPool). */
  workerUri?: string;
  dom?: DOMProps;
}

/** Surfaces a render-phase throw instead of a silent blank webview. */
class RenderBoundary extends Component<
  { children: ReactNode },
  { err: string | null }
> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
  render() {
    if (this.state.err) {
      return (
        <pre
          style={{
            color: "#dc2626",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            font: "11px ui-monospace, monospace",
            padding: 8,
          }}
        >
          {this.state.err}
        </pre>
      );
    }
    return this.props.children;
  }
}

export default function PierreView({
  kind,
  content,
  name,
  scheme,
  disableFileHeader = false,
  disableLineNumbers = false,
  onReady,
  collapsed,
  bottomInset = 0,
  workerUri,
}: PierreViewProps) {
  const decoded = decodeURIComponent(content);
  // Latest content, readable from `onPostRender` — which fires in Pierre's
  // child layout effect, BEFORE this component's passive effect below. Assigned
  // during render so it's already current when onPostRender runs.
  const decodedRef = useRef(decoded);
  decodedRef.current = decoded;
  // The content we've already fired `onReady` for. Content-keyed (not a boolean)
  // so the guard survives the layout-effect-before-passive-effect ordering — a
  // boolean reset in the effect would race onPostRender and get skipped.
  const firedForRef = useRef<string | null>(null);
  // CodeView's scroll viewport element (its root <div>), captured via the
  // library's containerRef. Single-file File/PatchDiff render no CodeView, so
  // this stays null and they scroll the webview document instead.
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Signal readiness once per payload (scroll reset is handled separately by the
  // `collapsed` effect below, which runs when the sheet closes).
  const fireReady = useCallback(
    (payload: string) => {
      if (firedForRef.current === payload) return;
      firedForRef.current = payload;
      onReady?.();
    },
    [onReady],
  );

  // Scroll back to top when the sheet collapses (closed). Done while hidden, so
  // reopening — warm reuse, button-close, or drag-dismiss — always starts at the
  // top with no visible jump on the way in. Reset BOTH scroll modes: the webview
  // document (single-file File/PatchDiff) and CodeView's own scroll container
  // (multi-file); whichever isn't in use is a harmless no-op.
  useEffect(() => {
    if (!collapsed) return;
    window.scrollTo(0, 0);
    containerRef.current?.scrollTo({ top: 0, left: 0 });
  }, [collapsed]);

  // Pierre calls `onPostRender` on each render commit: "mount" (plain), then
  // "update" after the highlight pass. Reveal on the highlighted commit. Two
  // ways to know it's highlighted: the main-thread highlighter is loaded (no
  // worker), OR the commit is an "update" — which is the post-highlight re-render
  // for BOTH the main-thread and the worker path (where `isHighlighterLoaded()`
  // stays false because tokenization happens off-thread). The FALLBACK_MS timer
  // still backstops the case where neither ever holds.
  const handlePostRender = useCallback(
    (_node: HTMLElement, _instance: unknown, phase: PostRenderPhase) => {
      if (phase === "unmount") return;
      if (!isHighlighterLoaded() && phase !== "update") return;
      fireReady(decodedRef.current);
    },
    [fireReady],
  );

  // Backstop per content change: if the highlighter never loads, onPostRender
  // never qualifies — open anyway after a timeout so the sheet can't hang.
  // Empty content is ready immediately.
  useEffect(() => {
    if (decoded.length === 0) {
      fireReady(decoded);
      return;
    }
    const t = setTimeout(() => fireReady(decoded), FALLBACK_MS);
    return () => clearTimeout(t);
  }, [decoded, fireReady]);

  // ── Off-thread highlight pool ─────────────────────────────────────────────
  // Pierre tokenizes (shiki) on a Web Worker so it doesn't block scroll. Following
  // Pierre's VS Code-webview pattern: the host passes a fetchable `workerUri`
  // (worker-portable.js as a Metro asset); we fetch it → Blob → blob URL →
  // `new Worker`. Until the blob URL is ready the components run main-thread
  // (disableWorkerPool); once ready the provider mounts and they re-render under
  // the pool.
  const [workerBlobUrl, setWorkerBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!workerUri) return;
    let active = true;
    let createdUrl: string | null = null;
    fetch(workerUri)
      .then((r) => r.text())
      .then((code) => {
        if (!active) return;
        createdUrl = URL.createObjectURL(
          new Blob([code], { type: "application/javascript" }),
        );
        setWorkerBlobUrl(createdUrl);
      })
      .catch((e) => console.warn("[worker-pool] load failed", String(e)));
    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [workerUri]);

  const poolOptions = useMemo(
    () =>
      workerBlobUrl
        ? { workerFactory: () => new Worker(workerBlobUrl), poolSize: 4 }
        : null,
    [workerBlobUrl],
  );
  const highlighterOptions = useMemo(
    () => ({
      theme: { dark: "pierre-dark", light: "pierre-light" } as const,
      // Preloaded grammars. A file whose language isn't listed falls back to
      // plain text (spike scope — broaden / make dynamic when productionizing).
      langs: [
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
      ] as SupportedLanguages[],
    }),
    [],
  );

  const theme = scheme === "dark" ? "pierre-dark" : "pierre-light";

  // Multi-file: Pierre parses a raw `git diff` (many `diff --git` sections)
  // into one item per file. Only computed for kind="multifile"; parsing a
  // non-diff string would just return [].
  const multifileItems = useMemo(
    () =>
      kind === "multifile"
        ? parsePatchFiles(decoded).flatMap((patch, pi) =>
            patch.files.map((fileDiff, fi) => ({
              id: `${pi}-${fi}`,
              type: "diff" as const,
              fileDiff,
            })),
          )
        : [],
    [kind, decoded],
  );

  const tree = (
    <RenderBoundary>
      {kind === "diff" ? (
        // Single-file diff scrolls the webview document. With WKWebView's auto
        // content-inset disabled (contentInsetAdjustmentBehavior:"never"), pad
        // the bottom by the safe-area inset so the last line clears the home
        // indicator.
        <div style={{ paddingBottom: bottomInset, flexShrink: 0 }}>
          <PatchDiff
            patch={decoded}
            disableWorkerPool={!poolOptions}
            options={{
              theme,
              diffStyle: "unified",
              // Full-line red/green tint + word-level intra-line emphasis.
              lineDiffType: "word",
              preferredHighlighter: "shiki-js",
              disableFileHeader,
              disableLineNumbers,
              onPostRender: handlePostRender,
            }}
          />
        </div>
      ) : kind === "multifile" ? (
        <CodeView
          items={multifileItems}
          disableWorkerPool={!poolOptions}
          containerRef={containerRef}
          // CodeView uses this root <div> as its scroll VIEWPORT: it reads
          // root.scrollTop and root.getBoundingClientRect().height to size its
          // render window. It MUST have a definite height — without one it
          // measures its own growing content as the viewport, a feedback loop
          // that re-expands the window every frame and ends up rendering every
          // line (the short→tall grow + no virtualization). flex:1 + minHeight:0
          // inside the viewport-bound #root column (see CSS) gives it a fixed
          // height; overflow:auto makes it the scroll container.
          style={{ flex: 1, minHeight: 0, overflow: "auto" }}
          options={{
            theme,
            diffStyle: "unified",
            lineDiffType: "word",
            stickyHeaders: true,
            preferredHighlighter: "shiki-js",
            // Extend the scroll content's bottom padding by the safe-area inset
            // so the last line clears the home indicator (single-file File/
            // PatchDiff get the same via a padded wrapper div). 8s are Pierre's
            // DEFAULT_CODE_VIEW_LAYOUT, replicated since passing `layout`
            // replaces the whole default.
            layout: { paddingTop: 0, paddingBottom: bottomInset, gap: 0 },
            onPostRender: handlePostRender,
          }}
        />
      ) : (
        // Same as the single-file diff: pad the document-scroll bottom by the
        // safe-area inset so the last line clears the home indicator.
        <div style={{ paddingBottom: bottomInset, flexShrink: 0 }}>
          <File
            file={{ name: name ?? "snippet.txt", contents: decoded }}
            disableWorkerPool={!poolOptions}
            options={{
              theme,
              preferredHighlighter: "shiki-js",
              disableFileHeader,
              disableLineNumbers,
              onPostRender: handlePostRender,
            }}
          />
        </div>
      )}
    </RenderBoundary>
  );

  return (
    <>
      <style>{CSS}</style>
      {poolOptions ? (
        <WorkerPoolContextProvider
          poolOptions={poolOptions}
          highlighterOptions={highlighterOptions}
        >
          {tree}
        </WorkerPoolContextProvider>
      ) : (
        tree
      )}
    </>
  );
}
