import { describe, expect, it } from "vitest";
import {
  codeLanguage,
  highlightTokens,
  MARKDOWN_CODE_LANGUAGES,
} from "./highlight";

const typed = (code: string, language: string) =>
  highlightTokens(code, language).map((t) => [
    code.slice(t.start, t.end),
    t.type,
  ]);

describe("highlightTokens", () => {
  it("maps highlights' scopes onto Astryx token types", () => {
    const code = 'export function f(n: number) { return "x" + 42; } // done';
    expect(typed(code, "typescript")).toEqual(
      expect.arrayContaining([
        ["export", "keyword"],
        ["function", "keyword"],
        ["f", "function"],
        ["number", "type"],
        ['"x"', "string"],
        ["42", "number"],
        ["// done", "comment"],
      ]),
    );
  });

  it("colors the text of a run, not its trailing space", () => {
    const [first] = highlightTokens("import x", "ts");
    expect(first).toEqual({ type: "keyword", start: 0, end: 6 });
  });

  it("takes extensions as languages and leaves unknown ones plain", () => {
    expect(highlightTokens("fn main() {}", "rs").length).toBeGreaterThan(0);
    expect(highlightTokens("whatever", "no-such-language")).toEqual([]);
  });
});

describe("codeLanguage", () => {
  it("gives a word highlights knows one language value, named as written", () => {
    const ts = codeLanguage("ts");
    expect(typeof ts).not.toBe("string");
    expect(codeLanguage("ts")).toBe(ts);
    expect(ts).toMatchObject({ name: "ts", identifiers: ["ts"] });
  });

  it("leaves other words, and plain text, to Astryx", () => {
    expect(codeLanguage("no-such-language")).toBe("no-such-language");
    expect(codeLanguage("text")).toBe("text");
  });

  it("lists every fence word for Markdown", () => {
    const words = MARKDOWN_CODE_LANGUAGES.flatMap((l) => l.identifiers);
    expect(words).toEqual(expect.arrayContaining(["tsx", "py", "bash"]));
    expect(new Set(words).size).toBe(words.length);
  });
});
