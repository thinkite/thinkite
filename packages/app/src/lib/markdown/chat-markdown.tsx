import { useColorScheme } from "react-native";
import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from "react-native-enriched-markdown";

/**
 * Chat-side markdown renderer for assistant text. Wraps
 * `react-native-enriched-markdown` (Software Mansion) — a Fabric component
 * that self-sizes via Yoga, supports GFM (tables, task lists,
 * strikethrough), and animates new tokens during streaming.
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
 * Streaming behavior (V0 ships streaming via Slice F+G+H):
 *   - `streamingAnimation` — fades in newly appended tokens as patch_text
 *     deltas arrive (every ~200ms during a turn, per envelope from the
 *     SDK iterator).
 *   - `streamingConfig.tableMode: 'hidden'` — hides incomplete GFM tables
 *     during streaming, then reveals them at boundary completion. Avoids
 *     the single-digit-fps reparse cost we measured on 0.5.0 stable.
 *     (See project_streaming_markdown_w3.md for the perf observation +
 *     decision history.)
 *   - `flavor: 'github'` — enables GFM extensions; commonmark-only would
 *     drop tables which Claude responses occasionally include.
 *
 * Tool detail (Read/Bash/Edit/Write outputs + diffs) is rendered separately by
 * `PierreView` (@pierre/diffs in an expo-dom WebView): syntax highlight +
 * raw-diff handling matter there, and tool-block rows live in a BottomSheet —
 * not on the LegendList scroll-flicker hot path.
 */

// Heading + paragraph metrics derived from a side-by-side comparison with
// Claude Desktop's chat typography (light mode, 2026-05-06). Headings stay
// close in size to body — distinction is mostly weight (700/500) — to keep
// chat density compact rather than blog-like.
const BODY_FONT_SIZE = 16;
const BODY_LINE_HEIGHT = 22;
// Exported: ChunkedMarkdown's broken-out CodeBlock must stay metric- and
// palette-identical to the code blocks enriched renders, so inline code
// (still enriched, inside runs) and block code (ours) read as one family.
export const CODE_FONT_SIZE = 14;
export const CODE_LINE_HEIGHT = 19;

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
}

export const LIGHT_PALETTE: ColorPalette = {
  text: "#0a0a0a",
  textMuted: "#404040",
  link: "#2563eb",
  inlineCodeBg: "#f4f4f5",
  inlineCodeBorder: "#f4f4f5",
  codeBlockBg: "#f4f4f5",
  codeBlockBorder: "#f4f4f5",
  blockquoteBorder: "#d4d4d8",
  bullet: "#525252",
  tableHeaderBg: "#eeeeef",
  tableRowBg: "#f4f4f5",
  tableBorder: "#ffffff",
};

export const DARK_PALETTE: ColorPalette = {
  text: "#fafafa",
  textMuted: "#a1a1aa",
  link: "#60a5fa",
  inlineCodeBg: "#27272a",
  inlineCodeBorder: "#27272a",
  codeBlockBg: "#18181b",
  codeBlockBorder: "#18181b",
  blockquoteBorder: "#3f3f46",
  bullet: "#a1a1aa",
  tableHeaderBg: "#27272a", // zinc-800 — one shade lighter than chat bg
  tableRowBg: "#18181b", // zinc-900
  tableBorder: "#202023",
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
      fontFamily: "Menlo",
      fontSize: CODE_FONT_SIZE,
      color: p.text,
      backgroundColor: p.inlineCodeBg,
      borderColor: p.inlineCodeBorder,
    },
    codeBlock: {
      fontFamily: "Menlo",
      fontSize: CODE_FONT_SIZE,
      lineHeight: CODE_LINE_HEIGHT,
      color: p.text,
      backgroundColor: p.codeBlockBg,
      borderColor: p.codeBlockBorder,
      borderRadius: 8,
      padding: 10,
      marginTop: 0,
      marginBottom: 12,
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
  /** Assistant message content. May be partial during streaming. */
  markdown: string;
}

export function ChatMarkdown({ markdown }: ChatMarkdownProps) {
  const colorScheme = useColorScheme() ?? "light";
  const markdownStyle = colorScheme === "dark" ? DARK_STYLE : LIGHT_STYLE;
  return (
    <EnrichedMarkdownText
      markdown={markdown}
      md4cFlags={{
        underline: true,
      }}
      flavor="github"
      streamingAnimation
      streamingConfig={{ tableMode: "progressive" }}
      markdownStyle={markdownStyle}
    />
  );
}
