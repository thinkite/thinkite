import {
  type CodeLanguage,
  createCodeLanguage,
} from "@astryxdesign/core/CodeBlock";
import {
  codeToTokens,
  isSupportedLanguage,
  type Lang,
  type Theme,
  tokenNames,
} from "@pierre/highlights";

// Syntax highlighting for Astryx's CodeBlock through Pierre's wasm lexers
// (@pierre/highlights), the engine the diff panel's Pierre pool runs too.
// CodeBlock takes a custom language whose synchronous `tokenize` returns
// token types and keeps its own syntax theme, so colors still come from
// Astryx; this only decides what is a keyword, a string and so on.
// Highlights tokenizes 2,000 lines of TypeScript in about 2ms, so running on
// the main thread is fine.
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

/** A custom language's `tokenize`. Unknown languages render plain. */
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

/** Highlights' names for no lexer at all; Astryx draws these plain itself. */
const PLAIN = new Set(["plain", "plaintext", "text", "txt"]);

const languages = new Map<string, CodeLanguage>();

/**
 * CodeBlock's `language` for a word (a fence's or a file extension):
 * highlights' lexer when it knows the word, else the word itself, which
 * Astryx's own grammars or plain text take. The label shows the word as
 * written; one value per word, so a block never re-tokenizes.
 */
export function codeLanguage(word: string): string | CodeLanguage {
  if (!isSupportedLanguage(word) || PLAIN.has(word)) return word;
  let language = languages.get(word);
  if (language === undefined) {
    language = createCodeLanguage({
      name: word,
      identifiers: [word],
      tokenize: highlightTokens,
    });
    languages.set(word, language);
  }
  return language;
}

/**
 * Fence words Markdown hands to highlights (its `codeLanguages`), ahead of
 * Astryx's built-in grammars; `diff-<word>` fences layer the diff over them.
 * Markdown matches a fence's word against this list, and highlights exports
 * no list of its own, so this names the words agents write; any other word
 * falls back to Astryx.
 */
// biome-ignore format: a word list reads best in rows
const FENCE_WORDS: Lang[] = [
  "ts", "typescript", "tsx", "js", "javascript", "jsx", "mjs", "cjs",
  "json", "jsonc", "json5", "jsonl", "yaml", "yml", "toml", "ini",
  "env", "dotenv", "properties", "csv", "log", "http", "xml", "svg",
  "html", "css", "scss", "sass", "less", "vue", "svelte", "astro",
  "md", "markdown", "mdx", "bash", "sh", "shell", "zsh", "powershell",
  "ps1", "py", "python", "rb", "ruby", "go", "golang", "rs", "rust",
  "swift", "kotlin", "kt", "java", "scala", "groovy", "gradle", "c",
  "h", "cpp", "c++", "cs", "csharp", "objc", "php", "lua", "perl", "r",
  "dart", "elixir", "erlang", "haskell", "ocaml", "clojure", "zig",
  "nim", "nix", "julia", "sql", "graphql", "gql", "prisma", "proto",
  "hcl", "terraform", "tf", "dockerfile", "docker", "makefile", "make",
  "cmake", "nginx", "latex", "tex", "glsl", "wgsl", "wat", "solidity",
];

/** Markdown's `codeLanguages`: every fence word above through highlights. */
export const MARKDOWN_CODE_LANGUAGES = FENCE_WORDS.map(codeLanguage).filter(
  (l): l is CodeLanguage => typeof l !== "string",
);
