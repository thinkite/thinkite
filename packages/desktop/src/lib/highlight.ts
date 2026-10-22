import {
  codeToTokens,
  isSupportedLanguage,
  type Theme,
  tokenNames,
} from "@pierre/highlights";

// Syntax highlighting for Astryx's CodeBlock through Pierre's wasm lexers
// (@pierre/highlights), the engine the diff panel's Pierre pool runs too.
// CodeBlock takes a synchronous `tokenizer` returning token types and keeps
// its own syntax theme, so colors still come from Astryx; this only decides
// what is a keyword, a string and so on. Highlights tokenizes 2,000 lines of
// TypeScript in about 2ms, so running on the main thread is fine.
//
// The trick: a theme whose colors are CSS variables makes highlights name
// each run's scope in its color — `var(--hls-keyword-import)` — which maps
// onto Astryx's 13 token types by its first word.

const SCOPES = tokenNames.filter(
  (n) => n !== "none" && n !== "background" && n !== "foreground",
);

const SCOPE_THEME: Theme = {
  name: "astryx-scopes",
  appearance: "light",
  style: { syntax: Object.fromEntries(SCOPES.map((n) => [n, "#000000"])) },
  cssVariables: true,
};

/** A highlights scope family → Astryx's token type (TOKEN_TYPES). */
const TYPE_OF: Record<string, string> = {
  keyword: "keyword",
  preproc: "keyword",
  string: "string",
  comment: "comment",
  number: "number",
  boolean: "constant",
  constant: "constant",
  function: "function",
  constructor: "function",
  type: "type",
  namespace: "type",
  enum: "type",
  tag: "tag",
  selector: "tag",
  attribute: "attribute",
  property: "property",
  label: "property",
  operator: "operator",
  punctuation: "punctuation",
  variable: "variable",
};

const PREFIX = "var(--hls-";

/** Past this, a block renders plain rather than stall a frame. */
const MAX_CHARS = 500_000;

export interface SyntaxToken {
  type: string;
  start: number;
  end: number;
}

/** Astryx CodeBlock's `tokenizer`. Unknown languages render plain. */
export function highlightTokens(code: string, language: string): SyntaxToken[] {
  if (code.length > MAX_CHARS || !isSupportedLanguage(language)) return [];
  const { tokens } = codeToTokens(code, { lang: language, theme: SCOPE_THEME });
  const out: SyntaxToken[] = [];
  for (const line of tokens) {
    for (const t of line) {
      if (t.color === undefined || !t.color.startsWith(PREFIX)) continue;
      const scope = t.color.slice(PREFIX.length, -1);
      const type = TYPE_OF[scope.split("-", 1)[0] ?? ""];
      // A run carries its trailing space ("import "); color the text only.
      const text = t.content.trimEnd();
      if (type !== undefined && text !== "")
        out.push({ type, start: t.offset, end: t.offset + text.length });
    }
  }
  return out;
}
