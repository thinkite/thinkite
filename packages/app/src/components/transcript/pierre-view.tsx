"use dom";

import { isHighlighterLoaded } from "@pierre/diffs";
import { File, PatchDiff, type PostRenderPhase } from "@pierre/diffs/react";
import type { DOMProps } from "expo/dom";
import {
  Component,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
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
 * one); the effect also resets scroll to top on content change.
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
:root, html, body { margin: 0; padding: 0; background: transparent; }
/* expo-dom sets #root { display:flex; flex:1 } which defaults to row — stack. */
#root { flex-direction: column; align-items: stretch; }
`;

// Open anyway if the highlighter never loads, so a wedged shiki can't hang the
// sheet open. onPostRender (below) is the fast path; this is only a backstop.
const FALLBACK_MS = 4000;

export interface PierreViewProps {
  kind: "diff" | "code";
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

  // Signal readiness once per payload: reset scroll to top (a resident/reused
  // webview keeps the prior payload's scroll) THEN fire `onReady`. Scrolling
  // here — at the moment we signal "open" — not in the effect below, because
  // onPostRender fires before that effect, so an effect-level scroll would land
  // AFTER the sheet already revealed the payload mid-scroll.
  const fireReady = useCallback(
    (payload: string) => {
      if (firedForRef.current === payload) return;
      firedForRef.current = payload;
      window.scrollTo(0, 0);
      onReady?.();
    },
    [onReady],
  );

  // Fast path. Pierre calls `onPostRender` each time it commits a render of THIS
  // payload to the DOM: phase "mount", then "update" after the async shiki pass
  // (File.emitPostRender → handleHighlightRender → rerender). We open on the
  // first commit where the highlighter is loaded — i.e. the HIGHLIGHTED render —
  // so the sheet reveals styled content, never the plain pre-highlight pass.
  const handlePostRender = useCallback(
    (_node: HTMLElement, _instance: unknown, phase: PostRenderPhase) => {
      if (phase === "unmount" || !isHighlighterLoaded()) return;
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

  const theme = scheme === "dark" ? "pierre-dark" : "pierre-light";

  return (
    <>
      <style>{CSS}</style>
      <RenderBoundary>
        {kind === "diff" ? (
          <PatchDiff
            patch={decoded}
            disableWorkerPool
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
        ) : (
          <File
            file={{ name: name ?? "snippet.txt", contents: decoded }}
            disableWorkerPool
            options={{
              theme,
              preferredHighlighter: "shiki-js",
              disableFileHeader,
              disableLineNumbers,
              onPostRender: handlePostRender,
            }}
          />
        )}
      </RenderBoundary>
    </>
  );
}
