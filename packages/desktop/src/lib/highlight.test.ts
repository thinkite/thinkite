import { describe, expect, it } from "vitest";
import { highlightTokens } from "./highlight";

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
