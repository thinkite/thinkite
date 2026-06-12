import { lexer } from "marked";
import { useMemo, useRef } from "react";

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

export interface ChunkStats {
  lexMs: number;
  segmentCount: number;
  /** First segment index whose raw changed vs the previous call (-1 = none). */
  firstChangedIndex: number;
}

/** Fence closer must sit on its own line — `foo\`\`\`` inside content is
 *  NOT a closer. Unclosed fences swallow to EOF (CommonMark), so only the
 *  LAST segment can ever be open. */
function isFencedCodeClosed(raw: string): boolean {
  const t = raw.trimEnd();
  const firstNewline = t.indexOf("\n");
  if (firstNewline < 0) return false; // just the opening fence line
  if (!t.startsWith("```") && !t.startsWith("~~~")) return true; // indented code
  return /\n[ \t]*(```|~~~)[ \t]*$/.test(t);
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

  for (const token of tokens) {
    if (token.type === "code") {
      flushRun();
      segments.push({
        kind: "code",
        key: `${segments.length}-code`,
        raw: token.raw,
        lang: typeof token.lang === "string" ? token.lang : "",
        code: typeof token.text === "string" ? token.text : "",
        closed: true, // non-last segments are closed by construction
      });
    } else {
      runBuffer += token.raw;
    }
  }
  flushRun();

  // Only the tail can be open; everything before it has tokens after it.
  const last = segments[segments.length - 1];
  if (last?.kind === "code") {
    last.closed = streamDone || isFencedCodeClosed(last.raw);
  }
  return segments;
}

export function useMarkdownBlocks(
  markdown: string,
  streamDone: boolean,
): { segments: MarkdownSegment[]; stats: ChunkStats } {
  const prevRef = useRef<MarkdownSegment[]>([]);
  return useMemo(() => {
    const t0 = performance.now();
    const segments = chunkMarkdown(markdown, streamDone);
    const lexMs = performance.now() - t0;

    const prev = prevRef.current;
    let firstChangedIndex = -1;
    const max = Math.max(segments.length, prev.length);
    for (let i = 0; i < max; i++) {
      const a = segments[i];
      const b = prev[i];
      if (!a || !b || a.raw !== b.raw || a.kind !== b.kind) {
        firstChangedIndex = i;
        break;
      }
    }
    prevRef.current = segments;
    return {
      segments,
      stats: { lexMs, segmentCount: segments.length, firstChangedIndex },
    };
  }, [markdown, streamDone]);
}
