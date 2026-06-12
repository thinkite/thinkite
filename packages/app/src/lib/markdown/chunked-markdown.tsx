import { memo, useMemo } from "react";
import {
  ScrollView,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";

import {
  ChatMarkdown,
  CODE_FONT_SIZE,
  CODE_LINE_HEIGHT,
  DARK_PALETTE,
  LIGHT_PALETTE,
} from "./chat-markdown";
import {
  resolveLang,
  type TokenLines,
  tokenizeCode,
  useHighlighter,
} from "./code-highlighter";
import type { ChunkStats } from "./markdown-chunking";
import { type MarkdownSegment, useMarkdownBlocks } from "./markdown-chunking";
import { useRemend } from "./remend";

/**
 * Chunked assistant-message renderer — the production counterpart to
 * whole-message ChatMarkdown (which it composes, not replaces):
 *
 *  - RUNS (text + tables) still render through enriched via ChatMarkdown
 *    — native attributed-text selection stays continuous across
 *    paragraphs and tables, and typography is byte-identical to before.
 *  - CODE BLOCKS break out into a horizontal-scroll Menlo code view with
 *    react-native-shiki-engine STREAMING highlight: naive full
 *    re-tokenize per delta (~1-3.5ms measured on device for typical
 *    blocks) + per-line memo keyed on token content, so settled lines
 *    skip reconciliation and only the streaming line re-renders.
 *  - Prefix-diff in useMarkdownBlocks guarantees completed segments
 *    never re-render while the tail streams.
 *
 * The code container is `TextInput multiline editable={false}` — a real
 * UITextView, which gives PARTIAL selection with handles (RN iOS <Text
 * selectable> is select-all only, facebook/react-native#13938). All
 * highlight spans nest inside it as one attributed string. Spans are
 * color-only over the same Menlo metrics as the plain fallback → zero
 * layout shift when the highlighter comes online.
 *
 * `streamDone` gates tail-run remend repair and EOF fence-close marking.
 * Callers without a settle signal pass `true` — that is exact parity
 * with the previous whole-message ChatMarkdown behavior (which never
 * had remend).
 */

const RunSegment = memo(function RunSegment({ raw }: { raw: string }) {
  return <ChatMarkdown markdown={raw} />;
});

/** Tail run while streaming: unterminated inline syntax gets repaired. */
function TailRunSegment({ raw }: { raw: string }) {
  const processed = useRemend(raw);
  return <ChatMarkdown markdown={processed} />;
}

function lineKeyOf(tokens: { content: string; color?: string }[]): string {
  let key = "";
  for (const t of tokens) key += `${t.color ?? ""}${t.content}`;
  return key;
}

/**
 * One source line as colored spans. Memo'd on lineKey: the naive full
 * re-tokenize produces identical tokens for lines the stream has moved
 * past, so settled lines skip reconciliation entirely.
 */
const TokenLine = memo(
  function TokenLine({
    tokens,
    newline,
  }: {
    tokens: { content: string; color?: string }[];
    lineKey: string;
    newline: boolean;
  }) {
    return (
      <Text>
        {tokens.map((t, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional within a line
          <Text key={i} style={t.color ? { color: t.color } : undefined}>
            {t.content}
          </Text>
        ))}
        {newline ? "\n" : null}
      </Text>
    );
  },
  (prev, next) =>
    prev.lineKey === next.lineKey && prev.newline === next.newline,
);

const CodeBlockSegment = memo(function CodeBlockSegment({
  lang,
  code,
  onTokenizeMs,
}: {
  lang: string;
  code: string;
  onTokenizeMs?: (ms: number) => void;
}) {
  const hl = useHighlighter();
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const palette = scheme === "dark" ? DARK_PALETTE : LIGHT_PALETTE;
  const langId = resolveLang(lang);

  const lines = useMemo<TokenLines | null>(() => {
    if (!hl || !langId) return null;
    const t0 = performance.now();
    const result = tokenizeCode(hl, code, langId, scheme);
    onTokenizeMs?.(performance.now() - t0);
    return result;
  }, [hl, langId, code, scheme, onTokenizeMs]);

  return (
    <View
      className="my-3 rounded-lg overflow-hidden"
      style={{
        backgroundColor: palette.codeBlockBg,
      }}
    >
      <ScrollView horizontal>
        <TextInput
          multiline
          editable={false}
          // Required: UITextView is itself a scroll view. Without this it
          // (a) won't participate in intrinsic content sizing — the block
          // can't auto-grow with streamed lines — and (b) its pan gesture
          // competes with the transcript list / horizontal ScrollView.
          scrollEnabled={false}
          style={{
            fontFamily: "Menlo",
            fontSize: CODE_FONT_SIZE,
            lineHeight: CODE_LINE_HEIGHT,
            color: palette.text,
            padding: 10,
          }}
        >
          {lines
            ? lines.map((lineTokens, i) => {
                const key = lineKeyOf(lineTokens);
                return (
                  <TokenLine
                    // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional
                    key={i}
                    tokens={lineTokens}
                    lineKey={key}
                    newline={i < lines.length - 1}
                  />
                );
              })
            : code}
        </TextInput>
      </ScrollView>
    </View>
  );
});

export function ChunkedMarkdown({
  markdown,
  streamDone,
  onStats,
  onTokenizeMs,
}: {
  markdown: string;
  /** No settle signal available? Pass `true` — exact parity with
   *  whole-message ChatMarkdown (no remend, EOF fences counted closed). */
  streamDone: boolean;
  /** Dev instrumentation. Called inline during render with the latest
   *  chunk stats — consumers must only write to a ref (no setState). */
  onStats?: (stats: ChunkStats) => void;
  /** Dev instrumentation. Per-tokenize timing from code blocks (ref-write
   *  only, same rule). Must be referentially stable or the CodeBlock memo
   *  breaks. */
  onTokenizeMs?: (ms: number) => void;
}) {
  const { segments, stats } = useMarkdownBlocks(markdown, streamDone);
  onStats?.(stats);

  const lastIndex = segments.length - 1;
  return (
    <View>
      {segments.map((seg: MarkdownSegment, i: number) => {
        if (seg.kind === "code") {
          return (
            <CodeBlockSegment
              key={seg.key}
              lang={seg.lang}
              code={seg.code}
              onTokenizeMs={onTokenizeMs}
            />
          );
        }
        // Tail run streams → remend; completed runs are frozen + memo'd.
        if (i === lastIndex && !streamDone) {
          return <TailRunSegment key={seg.key} raw={seg.raw} />;
        }
        return <RunSegment key={seg.key} raw={seg.raw} />;
      })}
    </View>
  );
}
