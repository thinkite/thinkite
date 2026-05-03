/**
 * File extension → tree-sitter language hint for `react-native-diffs`'
 * MarkdownView (HumanInterfaceDesign/MarkdownView) syntax highlighter.
 *
 * The lib bundles 19 language parsers (CodeHighlighter.swift in MarkdownView
 * registers them); this map covers every one plus a handful of widely-used
 * aliases. Anything not in the map → `undefined` → fenced as a plain
 * untagged code block (still readable, just no color).
 *
 * Lookup is by the LAST extension after the final dot, lower-cased. Special
 * filename patterns (`Dockerfile`, `Makefile`, etc.) are also handled.
 */

const EXTENSION_TO_LANG: Record<string, string> = {
  // Mainstream
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cxx: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  py: "python",
  pyi: "python",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "tsx",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  // Shell / config
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  // Web
  html: "html",
  htm: "html",
  css: "css",
};

const FILENAME_TO_LANG: Record<string, string> = {
  Dockerfile: "bash",
  Makefile: "bash",
  Brewfile: "ruby",
  Gemfile: "ruby",
  Rakefile: "ruby",
  Podfile: "ruby",
};

export function detectLanguageForPath(filePath: string): string | undefined {
  const last = filePath.split("/").pop() ?? filePath;
  if (FILENAME_TO_LANG[last] !== undefined) return FILENAME_TO_LANG[last];
  const dot = last.lastIndexOf(".");
  if (dot < 0 || dot === last.length - 1) return undefined;
  const ext = last.slice(dot + 1).toLowerCase();
  return EXTENSION_TO_LANG[ext];
}
