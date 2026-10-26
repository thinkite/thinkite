import { describe, expect, it } from "vitest";
import { linkBareUrls } from "./bare-urls";

describe("linkBareUrls", () => {
  it("links a dev server's URL, which md4c leaves as text", () => {
    expect(linkBareUrls("打开 http://localhost:5180/ 就能看到页面。")).toBe(
      "打开 <http://localhost:5180/> 就能看到页面。",
    );
    expect(linkBareUrls("| web | http://127.0.0.1:5180/ |")).toBe(
      "| web | <http://127.0.0.1:5180/> |",
    );
  });

  it("stops at trailing punctuation, CJK punctuation and unbalanced parens", () => {
    expect(linkBareUrls("See http://localhost:5180/a?b=1.")).toBe(
      "See <http://localhost:5180/a?b=1>.",
    );
    expect(linkBareUrls("访问http://localhost:5180/。")).toBe(
      "访问<http://localhost:5180/>。",
    );
    expect(linkBareUrls("(at http://localhost:5180/)")).toBe(
      "(at <http://localhost:5180/>)",
    );
    expect(linkBareUrls("**http://localhost:5180/**")).toBe(
      "**<http://localhost:5180/>**",
    );
  });

  it("leaves links and code alone", () => {
    for (const text of [
      "[web](http://localhost:5180/)",
      "[http://localhost:5180/](http://localhost:5180/)",
      "<http://localhost:5180/>",
      "run `curl http://localhost:8787/api`",
      "```\ncurl http://localhost:8787/api\n```",
      "no links here",
    ])
      expect(linkBareUrls(text)).toBe(text);
    expect(
      linkBareUrls(
        "```sh\ncurl http://localhost:8787\n```\nthen http://localhost:5180/",
      ),
    ).toBe(
      "```sh\ncurl http://localhost:8787\n```\nthen <http://localhost:5180/>",
    );
  });
});
