import { describe, expect, it } from "vitest";
import { LINK_RECOGNITION } from "./link-recognition";

const urls = (text: string) =>
  [...text.matchAll(new RegExp(LINK_RECOGNITION.text.source, "g"))].map(
    (m) => m[0],
  );

describe("LINK_RECOGNITION", () => {
  it("takes the dev-server URLs md4c leaves unlinked", () => {
    expect(urls("打开 http://localhost:5180/ 就能看到页面")).toEqual([
      "http://localhost:5180/",
    ]);
    expect(urls("| web | http://127.0.0.1:5180/a?b=1#c |")).toEqual([
      "http://127.0.0.1:5180/a?b=1#c",
    ]);
  });

  it("leaves out sentence and CJK punctuation and a closing paren", () => {
    expect(urls("访问http://localhost:5180/。")).toEqual([
      "http://localhost:5180/",
    ]);
    expect(urls("See http://localhost:5180/x.")).toEqual([
      "http://localhost:5180/x",
    ]);
    expect(urls("(at http://localhost:5180/)")).toEqual([
      "http://localhost:5180/",
    ]);
  });
});
