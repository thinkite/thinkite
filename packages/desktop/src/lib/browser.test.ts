import { describe, expect, it } from "vitest";
import {
  addressToUrl,
  browserTabs,
  browserTabsOf,
  MAX_BROWSER_TABS,
  openBrowserTab,
  showBrowserPage,
} from "./browser";

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

describe("showBrowserPage", () => {
  const tabs = (id: string) => browserTabsOf(browserTabs.get(), id);

  it("puts the page in place of the blank tab the user is on", () => {
    expect(showBrowserPage("s1", "http://localhost:5180/")).toBe(true);
    expect(tabs("s1")).toEqual({
      open: [{ n: 2, url: "http://localhost:5180/", title: "" }],
      active: 2,
    });
  });

  it("selects the tab already on the origin, wherever it went", () => {
    showBrowserPage("s2", "http://localhost:5180/");
    openBrowserTab("s2", "https://example.com/");
    showBrowserPage("s2", "http://localhost:5180/");
    expect(tabs("s2").active).toBe(2);
    expect(tabs("s2").open).toHaveLength(2);
  });

  it("by address, opens another page of a site the user has open", () => {
    showBrowserPage("s4", "https://github.com/a", "url");
    showBrowserPage("s4", "https://github.com/b", "url");
    showBrowserPage("s4", "https://github.com/a", "url");
    expect(tabs("s4").open.map((t) => t.url)).toEqual([
      "https://github.com/a",
      "https://github.com/b",
    ]);
    expect(tabs("s4").active).toBe(2);
  });

  it("never takes a page from the user, and says so when every tab is taken", () => {
    openBrowserTab("s3", "https://example.com/");
    showBrowserPage("s3", "http://localhost:5180/");
    expect(tabs("s3").open.map((t) => t.url)).toEqual([
      "about:blank",
      "https://example.com/",
      "http://localhost:5180/",
    ]);
    while (tabs("s3").open.length < MAX_BROWSER_TABS)
      openBrowserTab("s3", "https://example.com/x");
    expect(showBrowserPage("s3", "http://localhost:8080/")).toBe(false);
  });
});
