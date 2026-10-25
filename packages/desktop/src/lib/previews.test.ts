import type { PreviewEntry } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import {
  localPort,
  serverForLink,
  serverLabel,
  serverState,
  stoppedServerAt,
} from "./previews";

const entry = (over: Partial<PreviewEntry>): PreviewEntry => ({
  name: "web",
  ports: [5180, 24678],
  url: "http://localhost:5180/",
  status: "running",
  command: "bun run dev",
  started: { at: 1, sessionID: "ses_a" },
  ...over,
});

describe("localPort", () => {
  it("reads the port of a page on this Mac", () => {
    expect(localPort("http://localhost:5180/about")).toBe(5180);
    expect(localPort("http://127.0.0.1:5180/")).toBe(5180);
    expect(localPort("http://[::1]:5180/")).toBe(5180);
    expect(localPort("http://app.localhost:5180/")).toBe(5180);
    expect(localPort("http://localhost/")).toBe(80);
  });

  it("leaves other hosts and schemes alone", () => {
    expect(localPort("https://abc.trycloudflare.com/")).toBeUndefined();
    expect(localPort("https://example.com:5180/")).toBeUndefined();
    expect(localPort("about:blank")).toBeUndefined();
    expect(localPort("not a url")).toBeUndefined();
  });
});

describe("serverForLink", () => {
  it("finds the running server listening on a link's port", () => {
    expect(serverForLink([entry({})], "http://localhost:5180/x")?.name).toBe(
      "web",
    );
    expect(serverForLink([entry({})], "http://127.0.0.1:24678/")?.name).toBe(
      "web",
    );
  });

  it("leaves links no running server serves to the user's browser", () => {
    const ended = entry({ status: "ended", ended: { at: 2, by: "user" } });
    expect(serverForLink([ended], "http://localhost:5180/")).toBeUndefined();
    expect(
      serverForLink([entry({})], "http://localhost:3000/"),
    ).toBeUndefined();
    expect(
      serverForLink([entry({})], "https://example.com:5180/"),
    ).toBeUndefined();
    expect(
      serverForLink([entry({ ports: undefined })], "http://localhost:5180/"),
    ).toBeUndefined();
  });
});

describe("stoppedServerAt", () => {
  it("names the ended server of a tab's page", () => {
    const killed = entry({ status: "ended", ended: { at: 2, by: "user" } });
    expect(stoppedServerAt([killed], "http://localhost:5180/about")?.name).toBe(
      "web",
    );
    expect(stoppedServerAt([killed], "http://127.0.0.1:5180/")?.name).toBe(
      "web",
    );
  });

  it("says nothing while something live serves the page, or for other pages", () => {
    const killed = entry({ status: "ended", ended: { at: 2, by: "user" } });
    const again = entry({ name: "web2" });
    expect(
      stoppedServerAt([killed, again], "http://localhost:5180/"),
    ).toBeUndefined();
    expect(stoppedServerAt([killed], "http://localhost:3000/")).toBeUndefined();
    expect(
      stoppedServerAt([killed], "https://example.com:5180/"),
    ).toBeUndefined();
    expect(stoppedServerAt([killed], "about:blank")).toBeUndefined();
  });
});

describe("serverLabel / serverState", () => {
  it("labels a page by its port", () => {
    expect(serverLabel("http://localhost:5180/")).toBe(":5180");
  });

  it("says how a server ended", () => {
    const ended = (e: PreviewEntry["ended"]) =>
      serverState(entry({ status: "ended", ended: e }));
    expect(serverState(entry({}))).toBe("Running");
    expect(ended({ at: 1, by: "user" })).toBe("Stopped");
    expect(ended({ at: 1, by: "agent", sessionID: "ses_b" })).toBe(
      "Stopped by agent",
    );
    expect(ended({ at: 1, by: "process", exit: 1 })).toBe("Exited (1)");
    expect(ended({ at: 1, by: "external" })).toBe("Killed");
  });
});
