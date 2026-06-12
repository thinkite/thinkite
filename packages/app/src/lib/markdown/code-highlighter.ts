import type { HighlighterCore, ThemedToken } from "@shikijs/core";
import { createHighlighterCore } from "@shikijs/core";
import langDiff from "@shikijs/langs/diff";
import langJson from "@shikijs/langs/json";
import langJsonc from "@shikijs/langs/jsonc";
import langKotlin from "@shikijs/langs/kotlin";
import langMarkdown from "@shikijs/langs/markdown";
import langPython from "@shikijs/langs/python";
import langRust from "@shikijs/langs/rust";
import langShellscript from "@shikijs/langs/shellscript";
import langSql from "@shikijs/langs/sql";
import langSwift from "@shikijs/langs/swift";
import langToml from "@shikijs/langs/toml";
import langTsx from "@shikijs/langs/tsx";
import langYaml from "@shikijs/langs/yaml";
import themeGithubDark from "@shikijs/themes/github-dark";
import themeGithubLight from "@shikijs/themes/github-light";
import { useMemo, useSyncExternalStore } from "react";
import {
  createNativeEngine,
  isNativeEngineAvailable,
} from "react-native-shiki-engine";

/**
 * App-level highlighter singleton (the engine README is explicit about
 * never instantiating per-component). Native pattern compilation is lazy
 * + LRU-cached, so grammars cost bundle bytes, not startup time.
 *
 * Grammars are imported per-language — NEVER `@shikijs/langs` wholesale
 * (7.7MB) or `html` (silently chains javascript+css, ~291KB). Core set
 * ~535KB source, chosen by (a) sidecode's domain (TS/Swift/Kotlin) and
 * (b) what LLMs actually write in fence info-strings. One tsx grammar
 * covers the whole JS family via aliases (superset syntax; saves the
 * 180KB-each typescript/javascript grammars). Unknown languages degrade
 * to plain monospace.
 *
 * If the native TurboModule isn't in the current binary (pre-rebuild dev
 * client), the store stays null forever and code blocks render plain —
 * graceful, not fatal.
 */

let highlighter: HighlighterCore | null = null;
let initStarted = false;
const listeners = new Set<() => void>();

/** Kick off engine + grammar loading. Idempotent. Called from the root
 *  layout once the launch settles (the engine README recommends app-start
 *  init; the grammar JSON.parse burst (~535KB source) belongs in the
 *  launch quiet window, not the first session-enter navigation). The
 *  useHighlighter subscribe path keeps a deferred call as fallback. */
export function initHighlighter() {
  if (initStarted) return;
  initStarted = true;
  if (!isNativeEngineAvailable()) {
    console.warn(
      "[code-highlighter] native shiki engine unavailable — rebuild the dev client (pod install). Code blocks fall back to plain text.",
    );
    return;
  }
  createHighlighterCore({
    themes: [themeGithubLight, themeGithubDark],
    langs: [
      langTsx,
      langSwift,
      langPython,
      langShellscript,
      langSql,
      langRust,
      langYaml,
      langToml,
      langKotlin,
      langJson,
      langJsonc,
      langDiff,
      // 65KB standalone — its embedded-language list is LAZY (no chained
      // grammar imports, unlike html). Nested fences inside a ```markdown
      // block highlight for whatever grammars are loaded above; the rest
      // render plain.
      langMarkdown,
    ],
    engine: createNativeEngine(),
  })
    .then((h) => {
      highlighter = h;
      for (const l of listeners) l();
    })
    .catch((e) => {
      console.warn("[code-highlighter] init failed:", e);
    });
}

export function useHighlighter(): HighlighterCore | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      // Fallback only — the root layout already ran this at app launch in
      // any real flow; idempotent no-op here.
      initHighlighter();
      return () => listeners.delete(cb);
    },
    () => highlighter,
  );
}

/** Markdown info-string → loaded grammar id. */
const LANG_ALIASES: Record<string, string> = {
  // JS family — one tsx grammar covers all of it
  tsx: "tsx",
  ts: "tsx",
  typescript: "tsx",
  jsx: "tsx",
  js: "tsx",
  javascript: "tsx",
  swift: "swift",
  python: "python",
  py: "python",
  shellscript: "shellscript",
  sh: "shellscript",
  bash: "shellscript",
  shell: "shellscript",
  zsh: "shellscript",
  sql: "sql",
  rust: "rust",
  rs: "rust",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  kotlin: "kotlin",
  kt: "kotlin",
  json: "json",
  jsonc: "jsonc",
  diff: "diff",
  patch: "diff",
  markdown: "markdown",
  md: "markdown",
};

/** Info-strings that MEAN plain text — skip highlight without the
 *  dev-time miss log. ASCII diagrams arrive as bare fences (""). */
const PLAIN_LANGS = new Set([
  "",
  "text",
  "txt",
  "plain",
  "plaintext",
  "console",
  "output",
]);

const loggedMisses = new Set<string>();

/** Markdown info-string → loaded grammar id (null = render plain). */
export function resolveLang(infoString: string): string | null {
  const norm = infoString.trim().toLowerCase();
  if (PLAIN_LANGS.has(norm)) return null;
  const id = LANG_ALIASES[norm] ?? null;
  if (id === null && __DEV__ && !loggedMisses.has(norm)) {
    loggedMisses.add(norm);
    console.log(
      `[code-highlighter] no grammar for fence lang "${norm}" — rendering plain. Candidate for the alias table?`,
    );
  }
  return id;
}

export type TokenLines = ThemedToken[][];

export function tokenizeCode(
  hl: HighlighterCore,
  code: string,
  lang: string,
  scheme: "light" | "dark",
): TokenLines {
  return hl.codeToTokensBase(code, {
    lang,
    theme: scheme === "dark" ? "github-dark" : "github-light",
  });
}

// ─── Tokenization hook ──────────────────────────────────────────────────────

/** Tokenized lines for a code block, or null while the engine loads /
 *  for unsupported languages (null → caller renders plain text with
 *  identical metrics, so the colored flip is layout-neutral).
 *
 *  Deliberately SYNC on the render frame. A cached + time-sliced variant
 *  was built and A/B-tested (2026-06-12) and removed as unneeded: the
 *  drawer-settle gate in the session screen keeps mount bursts out of
 *  animation windows, and per-block tokenize (~1-3.5ms measured) is within
 *  budget at our session scale. Revisit (see
 *  memory/project_transcript_chunked_markdown_plan) if profiling ever
 *  shows tokenize back on a hot path. */
export function useCodeTokens(
  code: string,
  infoString: string,
  scheme: "light" | "dark",
  onTokenizeMs?: (ms: number) => void,
): TokenLines | null {
  const hl = useHighlighter();
  const langId = resolveLang(infoString);
  return useMemo(() => {
    if (hl === null || langId === null) return null;
    const t0 = performance.now();
    const lines = tokenizeCode(hl, code, langId, scheme);
    onTokenizeMs?.(performance.now() - t0);
    return lines;
  }, [hl, langId, code, scheme, onTokenizeMs]);
}
