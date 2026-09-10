import { useColorScheme, View } from "react-native";
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from "react-native-enriched-markdown";

import { useRemend } from "./remend";

/**
 * Markdown renderer for assistant text and markdown-bearing tool output.
 * Wraps `react-native-enriched-markdown` (Software Mansion) — a Fabric
 * component that self-sizes via Yoga, supports GFM (tables, task lists,
 * strikethrough), highlights fenced code natively (tree-sitter, compiled
 * in per the `enriched-markdown` block of package.json) and animates new
 * tokens during streaming.
 *
 * Why a native Fabric markdown component for chat (not a WebView/Nitro
 * renderer)?
 *   - A Fabric component is measured synchronously by Yoga on first layout,
 *     so each row hits LegendList with its real height — no flicker, no
 *     scroll drift on scroll-up. A renderer that reports size asynchronously
 *     (the former DiffsView/Nitro path, mrousavy/nitro#1199) causes a 0→real
 *     height transition that flickers under list virtualization.
 *   - It exposes chat typography (fontFamily / real italic) and animates new
 *     tokens during streaming — both of which plain-prose chat needs.
 *
 * One renderer for the whole message. Until enriched 1.0 the app split
 * assistant messages itself (marked.lexer prefix-diff → text runs through
 * enriched, code blocks through a shiki-highlighted TextInput) because
 * 0.x had no highlighter and repeated list markers on nested code lines
 * (software-mansion/enriched-markdown#243, fixed by #478). 1.0's github
 * flavor segments the AST itself (text runs, tables, code, math, quotes
 * are separate block views; selection never spanned segments anyway), so
 * the app-side chunker was pure duplication and was removed.
 *
 * Streaming behavior:
 *   - `streamingAnimation` — fades in newly appended tokens as patch_text
 *     deltas arrive (every ~200ms during a turn, per envelope from the
 *     SDK iterator).
 *   - `streamingConfig.tableMode: 'progressive'` — renders GFM tables
 *     incrementally as rows stream in.
 *   - `streamingConfig.codeBlockMode: 'progressive'` — code streams in
 *     line by line with the header visible; highlighting is applied once
 *     when the closing fence arrives instead of flickering per token.
 *   - remend repairs unterminated INLINE syntax (`**bold`, half-typed
 *     links) mid-stream — the layer enriched's streaming props don't cover.
 *   - `flavor: 'github'` — enables GFM extensions; commonmark-only would
 *     drop tables which Claude responses occasionally include.
 *
 * Tool detail (Read/Bash/Edit/Write outputs + diffs) is rendered separately by
 * `PierreView` (@pierre/diffs in an expo-dom WebView): raw-diff handling
 * matters there, and tool-block rows live in a BottomSheet — not on the
 * LegendList scroll-flicker hot path.
 */

// Heading + paragraph metrics derived from a side-by-side comparison with
// Claude Desktop's chat typography (light mode, 2026-05-06). Headings stay
// close in size to body — distinction is mostly weight (700/500) — to keep
// chat density compact rather than blog-like.
const BODY_FONT_SIZE = 16;
const BODY_LINE_HEIGHT = 22;
const CODE_FONT_SIZE = 14;
const CODE_LINE_HEIGHT = 19;
// JetBrains Mono, embedded at build time via the expo-font config plugin
// (app.json; Regular + Bold TTFs from @expo-google-fonts/jetbrains-mono —
// the package is only the TTF source, we deliberately do NOT use its
// useFonts runtime loading: the transcript needs the font synchronously
// at first native render, no flash-of-fallback). Matches the Pierre diff
// webview, which already ships JetBrains Mono woff2.
const CODE_FONT_FAMILY = "JetBrains Mono";

interface ColorPalette {
  text: string;
  textMuted: string;
  link: string;
  inlineCodeBg: string;
  inlineCodeBorder: string;
  codeBlockBg: string;
  codeBlockBorder: string;
  blockquoteBorder: string;
  bullet: string;
  tableHeaderBg: string;
  tableRowBg: string;
  tableBorder: string;
  /** tree-sitter capture → foreground. Values are the Pierre theme's
   *  TextMate colors (the same palette the Pierre diff sheet renders
   *  with) mapped onto enriched's 14 token slots, so chat code blocks and
   *  the diff sheet read as one family. `variable` and `embedded` are left
   *  unset on purpose: tree-sitter captures every identifier as
   *  `variable`, and painting them all orange is not what Pierre does. */
  syntax: NonNullable<NonNullable<MarkdownStyle["codeBlock"]>["syntaxColors"]>;
}

const LIGHT_PALETTE: ColorPalette = {
  text: "#0a0a0a",
  textMuted: "#404040",
  link: "#2563eb",
  inlineCodeBg: "#f4f4f5",
  inlineCodeBorder: "#f4f4f5",
  // Code blocks sit on the Pierre theme's own editor background (the
  // same surface the Pierre diff sheet renders on) with a visible border
  // carrying the block boundary — the bg matches the chat bg in both modes.
  codeBlockBg: "#ffffff",
  codeBlockBorder: "#e4e4e7",
  blockquoteBorder: "#d4d4d8",
  bullet: "#525252",
  tableHeaderBg: "#eeeeef",
  tableRowBg: "#f4f4f5",
  tableBorder: "#ffffff",
  syntax: {
    keyword: "#d32a61",
    operator: "#636363",
    punctuation: "#636363",
    string: "#199f43",
    number: "#1ca1c7",
    constant: "#1ca1c7",
    comment: "#737373",
    function: "#693acf",
    type: "#a631be",
    property: "#d47628",
    tag: "#d5512f",
    attribute: "#18a46c",
  },
};

const DARK_PALETTE: ColorPalette = {
  text: "#fafafa",
  textMuted: "#a1a1aa",
  link: "#60a5fa",
  inlineCodeBg: "#27272a",
  inlineCodeBorder: "#27272a",
  // pierre-dark editor.background; border = zinc-800 (see light note).
  codeBlockBg: "#0a0a0a",
  codeBlockBorder: "#27272a",
  blockquoteBorder: "#3f3f46",
  bullet: "#a1a1aa",
  tableHeaderBg: "#27272a", // zinc-800 — one shade lighter than chat bg
  tableRowBg: "#18181b", // zinc-900
  tableBorder: "#202023",
  syntax: {
    keyword: "#ff678d",
    operator: "#636363",
    punctuation: "#636363",
    string: "#5ecc71",
    number: "#68cdf2",
    constant: "#68cdf2",
    comment: "#737373",
    function: "#9d6afb",
    type: "#d568ea",
    property: "#ffa359",
    tag: "#ff855e",
    attribute: "#60d199",
  },
};

function buildStyle(p: ColorPalette): MarkdownStyle {
  return {
    paragraph: {
      fontSize: BODY_FONT_SIZE,
      lineHeight: BODY_LINE_HEIGHT,
      fontWeight: "400",
      color: p.text,
      marginTop: 0,
      marginBottom: 12,
    },
    h1: {
      fontSize: 18,
      lineHeight: 22,
      fontWeight: "400",
      color: p.text,
      marginTop: 0,
      marginBottom: 12,
    },
    h2: {
      fontSize: 17,
      lineHeight: 22,
      fontWeight: "500",
      color: p.text,
      marginTop: 0,
      marginBottom: 12,
    },
    h3: {
      fontSize: BODY_FONT_SIZE,
      lineHeight: BODY_LINE_HEIGHT,
      fontWeight: "500",
      color: p.text,
      marginTop: 0,
      marginBottom: 12,
    },
    h4: {
      fontSize: BODY_FONT_SIZE,
      lineHeight: BODY_LINE_HEIGHT,
      fontWeight: "500",
      color: p.text,
      marginTop: 0,
      marginBottom: 12,
    },
    h5: {
      fontSize: BODY_FONT_SIZE,
      lineHeight: BODY_LINE_HEIGHT,
      fontWeight: "500",
      color: p.text,
      marginTop: 0,
      marginBottom: 12,
    },
    h6: {
      fontSize: BODY_FONT_SIZE,
      lineHeight: BODY_LINE_HEIGHT,
      fontWeight: "500",
      color: p.text,
      marginTop: 0,
      marginBottom: 12,
    },
    code: {
      fontFamily: CODE_FONT_FAMILY,
      fontSize: CODE_FONT_SIZE,
      color: p.text,
      backgroundColor: p.inlineCodeBg,
      borderColor: p.inlineCodeBorder,
    },
    codeBlock: {
      fontFamily: CODE_FONT_FAMILY,
      fontSize: CODE_FONT_SIZE,
      lineHeight: CODE_LINE_HEIGHT,
      color: p.text,
      backgroundColor: p.codeBlockBg,
      borderColor: p.codeBlockBorder,
      borderWidth: 1,
      borderRadius: 8,
      padding: 10,
      marginTop: 0,
      marginBottom: 12,
      syntaxColors: p.syntax,
    },
    blockquote: {
      fontSize: BODY_FONT_SIZE,
      lineHeight: BODY_LINE_HEIGHT,
      color: p.textMuted,
      borderColor: p.blockquoteBorder,
      borderWidth: 3,
      gapWidth: 10,
      marginTop: 0,
      marginBottom: 12,
      backgroundColor: "transparent",
    },
    list: {
      fontSize: BODY_FONT_SIZE,
      lineHeight: BODY_LINE_HEIGHT,
      color: p.text,
      bulletColor: p.bullet,
      markerColor: p.bullet,
      marginTop: 0,
      marginBottom: 12,
    },
    link: {
      color: p.link,
      underline: true,
    },
    table: {
      // Cell text inherits paragraph metrics so chat density carries through
      // table content. Set explicitly because Table doesn't auto-inherit
      // paragraph style.
      fontSize: BODY_FONT_SIZE,
      lineHeight: BODY_LINE_HEIGHT,
      color: p.text,
      marginTop: 0,
      marginBottom: 12,
      headerBackgroundColor: p.tableHeaderBg,
      headerTextColor: p.text,
      rowEvenBackgroundColor: p.tableRowBg,
      rowOddBackgroundColor: p.tableRowBg,
      borderColor: p.tableBorder,
      borderWidth: 2,
      borderRadius: 2,
    },
    math: {
      marginTop: 0,
      marginBottom: 12,
    },
  };
}

const LIGHT_STYLE = buildStyle(LIGHT_PALETTE);
const DARK_STYLE = buildStyle(DARK_PALETTE);

export interface ChatMarkdownProps {
  /** Message content. May be partial during streaming. */
  markdown: string;
  /** True ONLY for content actively receiving deltas (the streaming
   *  assistant message). Callers without a settle signal (tool output)
   *  leave it false. Drives two things:
   *
   *  - remend repair of unterminated inline syntax (only meaningful while
   *    the text is still growing);
   *  - enriched's `streamingAnimation`, which is a PERFORMANCE switch, not
   *    just a fade:
   *    - `false` (settled) → enriched's measurement CACHE is active —
   *      re-mounting a session is cache hits instead of mock-rendering
   *      every message synchronously just to measure it (the dominant
   *      cost of session-enter jank, ~15→35+ JS fps measured 2026-06-12).
   *    - `true` (streaming) → bounds fast path gives cheap re-measures
   *      between deltas. NEVER use false here: every delta is a new
   *      string, so the cache misses every tick and enriched would
   *      mock-render the whole message per delta.
   *
   *  The true→false settle flip forces one exact re-measure upstream
   *  (ENRMPropsNeedExactStreamingMeasurement), snapping away any rounding
   *  drift accumulated while streaming. */
  streaming?: boolean;
}

export function ChatMarkdown({
  markdown,
  streaming = false,
}: ChatMarkdownProps) {
  const colorScheme = useColorScheme() ?? "light";
  const markdownStyle = colorScheme === "dark" ? DARK_STYLE : LIGHT_STYLE;
  const content = useRemend(markdown, streaming);
  return (
    // The plain View wrapper is LOAD-BEARING, not decoration: with enriched
    // as a direct flex child of the message column, repeated layout passes
    // (e.g. swiping a sibling horizontal ScrollView) inflated its measured
    // height by ~0.5px per pass — visible as growing blank space inside the
    // message. An ordinary View between the column and enriched breaks that
    // measure→round→remeasure loop. Verified by A/B on device 2026-06-12.
    <View>
      <EnrichedMarkdownText
        markdown={content}
        md4cFlags={{
          underline: true,
        }}
        flavor="github"
        streamingAnimation={streaming}
        streamingConfig={{
          tableMode: "progressive",
          codeBlockMode: "progressive",
        }}
        markdownStyle={markdownStyle}
      />
    </View>
  );
}
