import type { Token, Tokens } from "marked";
import { lexer } from "marked";
import { useMemo } from "react";

/**
 * Chunked markdown for the native transcript
 * (design doc: memory/project_transcript_chunked_markdown_plan).
 *
 * marked.lexer over the whole message per delta (pure JS, ms-level), then
 * segments are derived with a code-only breakout:
 *  - consecutive non-code tokens (INCLUDING tables — V0 decision) merge
 *    into RUNS rendered by enriched → selection stays continuous across
 *    text+tables, breaks only at code boundaries;
 *  - fenced/indented code becomes <CodeBlock> segments with a `closed`
 *    flag (close-time-gated work, e.g. a long-block highlight fuse, can
 *    hang off it).
 *
 * LIST HOIST: fenced code NESTED in list items (incl. task items and
 * nested lists) is also broken out — enriched repeats the list marker on
 * every code line (software-mansion-labs/react-native-enriched-markdown
 * #243, open). The list's raw is split at fence boundaries; ordered-list
 * numbering survives because the continuation run still carries the
 * literal "2."/"3." markers and GFM honors a list's first number. Known
 * tradeoffs: hoisted code renders full-width (list indent lost), and any
 * post-code content of the same item becomes a plain paragraph.
 * Blockquotes are deliberately NOT hoisted — #243 is list-marker-specific
 * and a hoist would visually break the quote bar around the code.
 *
 * Stability model: segments are keyed POSITIONALLY (`i-kind`). Children
 * memo on `raw`, so the prefix-diff guarantee we rely on is "unchanged
 * raw ⇒ no re-render", not "unchanged key". Lists/setext headings can
 * retroactively merge earlier blocks — token.raw comparison from the
 * start catches that correctly (everything from the divergence point
 * re-renders, which is exactly right).
 */

export type MarkdownSegment =
  | { kind: "run"; key: string; raw: string }
  | {
      kind: "code";
      key: string;
      raw: string;
      lang: string;
      code: string;
      closed: boolean;
    };

/** Fence closer must sit on its own line — `foo\`\`\`` inside content is
 *  NOT a closer. Unclosed fences swallow to EOF (CommonMark), so only the
 *  LAST segment can ever be open. */
function isFencedCodeClosed(raw: string): boolean {
  const t = raw.trimEnd();
  if (!t.startsWith("```") && !t.startsWith("~~~")) return true; // indented code
  if (t.indexOf("\n") < 0) return false; // just the opening fence line
  return /\n[ \t]*(```|~~~)[ \t]*$/.test(t);
}

/** Fenced code anywhere down a list's item tree (nested lists recursed,
 *  blockquotes deliberately not — see header). Indented (non-fenced) code
 *  inside items is excluded: the line scanner below only understands
 *  fences, and LLM output is fenced in practice. */
function listHasNestedFence(list: Tokens.List): boolean {
  for (const item of list.items) {
    for (const t of item.tokens as Token[]) {
      if (t.type === "code" && /^(`{3,}|~{3,})/.test(t.raw.trimStart())) {
        return true;
      }
      if (t.type === "list" && listHasNestedFence(t as Tokens.List)) {
        return true;
      }
    }
  }
  return false;
}

type ListPiece =
  | { kind: "run"; raw: string }
  | { kind: "code"; raw: string; lang: string; code: string; closed: boolean };

/** A fence-open line inside list raw: indentation, optionally the list
 *  marker itself ("1. ```ts" — fence as the item's first block), then the
 *  fence and its info string. The captured prefix length is what GFM
 *  strips from the content lines (continuation indent = marker width). */
const LIST_FENCE_OPEN =
  /^([ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?)(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

function dedent(line: string, max: number): string {
  let n = 0;
  while (n < max && line[n] === " ") n++;
  return line.slice(n);
}

/** Split a list token's raw at fence boundaries. Pure text surgery on the
 *  ORIGINAL raw (concatenating the pieces reproduces it exactly), so run
 *  pieces keep their literal list markers. Scanner-conservative: a fence
 *  shape it doesn't recognize (e.g. inside a nested blockquote, where the
 *  line starts with ">") simply stays in the run — worst case is the
 *  pre-hoist behavior, never corruption. */
function splitListRaw(raw: string): ListPiece[] {
  // Lines WITH their trailing newline (Hermes-safe; no lookbehind).
  const lines = raw.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const pieces: ListPiece[] = [];
  let run: string[] = [];
  const flushRunPiece = () => {
    if (run.length > 0) {
      pieces.push({ kind: "run", raw: run.join("") });
      run = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const open = LIST_FENCE_OPEN.exec(line.replace(/\n$/, ""));
    if (open === null) {
      run.push(line);
      i++;
      continue;
    }
    const prefixLen = open[1]?.length ?? 0;
    const fence = open[2] ?? "";
    const info = (open[3] ?? "").trim();
    const rawLines: string[] = [line];
    const codeLines: string[] = [];
    let closed = false;
    i++;
    while (i < lines.length) {
      const l = lines[i] ?? "";
      rawLines.push(l);
      i++;
      const close = FENCE_CLOSE.exec(l.replace(/\n$/, ""));
      if (
        close !== null &&
        close[1]?.[0] === fence[0] &&
        (close[1]?.length ?? 0) >= fence.length
      ) {
        closed = true;
        break;
      }
      codeLines.push(dedent(l, prefixLen));
    }
    flushRunPiece();
    pieces.push({
      kind: "code",
      raw: rawLines.join(""),
      lang: info,
      code: codeLines.join("").replace(/\n$/, ""),
      closed,
    });
  }
  flushRunPiece();
  return pieces;
}

export function chunkMarkdown(
  markdown: string,
  streamDone: boolean,
): MarkdownSegment[] {
  const tokens = lexer(markdown);
  const segments: MarkdownSegment[] = [];
  let runBuffer = "";

  const flushRun = () => {
    if (!runBuffer) return;
    segments.push({
      kind: "run",
      key: `${segments.length}-run`,
      raw: runBuffer,
    });
    runBuffer = "";
  };
  const pushCode = (
    raw: string,
    lang: string,
    code: string,
    closed: boolean,
  ) => {
    flushRun();
    segments.push({
      kind: "code",
      key: `${segments.length}-code`,
      raw,
      lang,
      code,
      closed,
    });
  };

  for (const token of tokens) {
    if (token.type === "code") {
      pushCode(
        token.raw,
        typeof token.lang === "string" ? token.lang : "",
        typeof token.text === "string" ? token.text : "",
        isFencedCodeClosed(token.raw),
      );
    } else if (
      token.type === "list" &&
      // `type` alone doesn't narrow past marked's Tokens.Generic.
      listHasNestedFence(token as Tokens.List)
    ) {
      for (const piece of splitListRaw(token.raw)) {
        if (piece.kind === "code") {
          pushCode(piece.raw, piece.lang, piece.code, piece.closed);
        } else {
          runBuffer += piece.raw;
        }
      }
    } else {
      runBuffer += token.raw;
    }
  }
  flushRun();

  // Only the tail can be open (unclosed fences swallow to EOF); when the
  // stream is done, an EOF-unterminated fence counts as closed.
  const last = segments[segments.length - 1];
  if (last?.kind === "code" && streamDone) {
    last.closed = true;
  }
  return segments;
}

export function useMarkdownBlocks(
  markdown: string,
  streamDone: boolean,
): MarkdownSegment[] {
  return useMemo(
    () => chunkMarkdown(markdown, streamDone),
    [markdown, streamDone],
  );
}
