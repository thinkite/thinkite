import type { BrowserRequest, PreviewEntry } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import {
  dueToShow,
  requestKey,
  serverLabel,
  serverState,
  stoppedServerAt,
} from "./previews";

const entry = (over: Partial<PreviewEntry>): PreviewEntry => ({
  name: "web",
  url: "http://localhost:5180/",
  localPort: 5180,
  status: "running",
  command: "bun run dev",
  started: { at: 1, sessionID: "ses_a" },
  ...over,
});

const request = (over: Partial<BrowserRequest>): BrowserRequest => ({
  url: "http://localhost:5180/",
  sessionID: "ses_a",
  at: 10,
  server: "web",
  ...over,
});

describe("dueToShow", () => {
  const handledAt = (map: Record<string, number>) => (key: string) => map[key];

  it("takes this session's requests this device has not acted on", () => {
    const snapshot = { entries: [entry({})], requests: [request({})] };
    const key = requestKey(request({}));
    expect(dueToShow(snapshot, "ses_a", handledAt({})).open).toHaveLength(1);
    expect(
      dueToShow(snapshot, "ses_a", handledAt({ [key]: 10 })).pending,
    ).toEqual([]);
    expect(
      dueToShow(
        { ...snapshot, requests: [request({ at: 11 })] },
        "ses_a",
        handledAt({ [key]: 10 }),
      ).open,
    ).toHaveLength(1);
  });

  it("leaves other sessions' requests", () => {
    const snapshot = { entries: [entry({})], requests: [request({})] };
    expect(dueToShow(snapshot, "ses_b", handledAt({})).pending).toEqual([]);
  });

  it("records but does not open a page whose server has stopped", () => {
    const due = dueToShow(
      {
        entries: [entry({ status: "ended", ended: { at: 20, by: "user" } })],
        requests: [request({})],
      },
      "ses_a",
      handledAt({}),
    );
    expect(due.pending).toHaveLength(1);
    expect(due.open).toEqual([]);
  });

  it("opens a page no server of ours serves (a tunnel, a public site)", () => {
    const tunnel = request({
      url: "https://abc.trycloudflare.com/",
      server: undefined,
    });
    expect(
      dueToShow({ entries: [], requests: [tunnel] }, "ses_a", handledAt({}))
        .open,
    ).toEqual([tunnel]);
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
    expect(
      stoppedServerAt(
        [entry({ url: undefined, status: "ended" })],
        "about:blank",
      ),
    ).toBeUndefined();
  });

  it("matches a tunnel by its origin", () => {
    const tunnel = entry({
      url: "https://abc.trycloudflare.com/",
      status: "ended",
      ended: { at: 2, by: "process", exit: 1 },
    });
    expect(
      stoppedServerAt([tunnel], "https://abc.trycloudflare.com/x")?.name,
    ).toBe("web");
    expect(
      stoppedServerAt([tunnel], "https://other.trycloudflare.com/"),
    ).toBeUndefined();
  });
});

describe("serverLabel / serverState", () => {
  it("labels a page by its port on this Mac and by its host elsewhere", () => {
    expect(serverLabel("http://localhost:5180/")).toBe(":5180");
    expect(serverLabel("https://abc.trycloudflare.com/")).toBe(
      "abc.trycloudflare.com",
    );
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
