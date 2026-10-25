import { describe, expect, it } from "vitest";
import { localPort, macPageNotice } from "./mac-link";

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

describe("macPageNotice", () => {
  it("names the server on the link's port", () => {
    const ports = [{ port: 5173, directory: "/proj", name: "web" }];
    expect(macPageNotice(5173, ports).title).toBe(`"web" runs on your Mac`);
    expect(macPageNotice(3000, ports).title).toBe(
      "Not reachable from your phone",
    );
  });
});
