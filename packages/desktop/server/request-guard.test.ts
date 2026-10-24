import { describe, expect, it } from "vitest";
import { createRequestGuard } from "./request-guard.ts";

describe("createRequestGuard", () => {
  const allow = createRequestGuard([
    "http://127.0.0.1:5199",
    "http://localhost:5199",
    "http://localhost:5183/",
  ]);

  it("lets the app's own page through", () => {
    expect(allow({ host: "127.0.0.1:5199" })).toBe(true);
    expect(
      allow({
        host: "127.0.0.1:5199",
        origin: "http://127.0.0.1:5199",
        "sec-fetch-site": "same-origin",
      }),
    ).toBe(true);
    // Dev: the Vite server forwards with its own Host and Origin.
    expect(
      allow({ host: "localhost:5183", origin: "http://localhost:5183" }),
    ).toBe(true);
    expect(allow({ host: "127.0.0.1:5199", "sec-fetch-site": "none" })).toBe(
      true,
    );
  });

  it("turns away other pages", () => {
    expect(
      allow({ host: "127.0.0.1:5199", origin: "https://evil.example" }),
    ).toBe(false);
    expect(allow({ host: "127.0.0.1:5199", origin: "null" })).toBe(false);
    // A dev server previewed in the session panel's browser.
    expect(
      allow({ host: "127.0.0.1:5199", origin: "http://localhost:3000" }),
    ).toBe(false);
    expect(
      allow({ host: "127.0.0.1:5199", "sec-fetch-site": "cross-site" }),
    ).toBe(false);
    expect(
      allow({ host: "127.0.0.1:5199", "sec-fetch-site": "same-site" }),
    ).toBe(false);
  });

  it("turns away a domain rebound to loopback", () => {
    expect(allow({ host: "evil.example:5199" })).toBe(false);
    expect(
      allow({
        host: "evil.example:5199",
        origin: "http://evil.example:5199",
        "sec-fetch-site": "same-origin",
      }),
    ).toBe(false);
    expect(allow({})).toBe(false);
  });
});
