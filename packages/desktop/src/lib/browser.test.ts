import { describe, expect, it } from "vitest";
import { addressToUrl } from "./browser";

describe("address bar", () => {
  it("keeps a URL with a scheme", () => {
    expect(addressToUrl("https://example.com/a?b")).toBe(
      "https://example.com/a?b",
    );
  });

  it("opens localhost and bare IPs over http", () => {
    expect(addressToUrl("localhost:3000")).toBe("http://localhost:3000");
    expect(addressToUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
  });

  it("opens other hosts over https", () => {
    expect(addressToUrl("example.com")).toBe("https://example.com");
    expect(addressToUrl("docs.example.com:8443/p")).toBe(
      "https://docs.example.com:8443/p",
    );
  });

  it("searches for anything else", () => {
    expect(addressToUrl("electron webview")).toBe(
      "https://duckduckgo.com/?q=electron%20webview",
    );
    expect(addressToUrl("  ")).toBe("about:blank");
  });
});
