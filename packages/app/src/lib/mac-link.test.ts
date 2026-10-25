import { describe, expect, it } from "vitest";
import { localPort, macPageNotice, phonePage } from "./mac-link";

describe("localPort", () => {
  it("reads the port of a page on the Mac itself", () => {
    expect(localPort("http://localhost:5173/about")).toBe(5173);
    expect(localPort("http://127.0.0.1:5173/")).toBe(5173);
    expect(localPort("http://[::1]:8787/")).toBe(8787);
    expect(localPort("http://app.localhost:5173/")).toBe(5173);
  });

  it("leaves pages elsewhere to the browser", () => {
    expect(localPort("https://abc.trycloudflare.com/")).toBeUndefined();
    expect(localPort("mailto:a@b.c")).toBeUndefined();
    expect(localPort("not a url")).toBeUndefined();
  });
});

describe("phonePage", () => {
  it("moves the page to the phone's localhost, keeping the rest", () => {
    expect(phonePage("http://127.0.0.1:5173/a/b?x=1#top")).toBe(
      "http://localhost:5173/a/b?x=1#top",
    );
    expect(phonePage("http://app.localhost:5173/")).toBe(
      "http://localhost:5173/",
    );
  });
});

describe("macPageNotice", () => {
  const ports = [{ port: 5173, directory: "/proj", name: "web" }];

  it("says why the phone can't show it", () => {
    expect(macPageNotice(3000, ports).title).toBe(
      "Not reachable from your phone",
    );
    expect(macPageNotice(5173, ports, "address in use").title).toBe(
      "Port 5173 is taken on this phone",
    );
    expect(macPageNotice(5173, ports).title).toBe(`"web" isn't connected yet`);
  });
});
