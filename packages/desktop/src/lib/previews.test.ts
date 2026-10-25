import type { PreviewEntry } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import { dueToShow, stoppedServerAt } from "./previews";

const entry = (over: Partial<PreviewEntry>): PreviewEntry => ({
  name: "web",
  ports: [5180],
  primaryPort: 5180,
  status: "running",
  command: "bun run dev",
  sessions: ["ses_a"],
  startedAt: 1,
  ...over,
});

describe("dueToShow", () => {
  const opened = { at: 10, sessionID: "ses_a" };

  it("takes a request for this session that this device has not acted on", () => {
    expect(
      dueToShow([entry({ opened })], "ses_a", () => undefined),
    ).toHaveLength(1);
    expect(dueToShow([entry({ opened })], "ses_a", () => 10)).toEqual([]);
    expect(
      dueToShow(
        [entry({ opened: { at: 11, sessionID: "ses_a" } })],
        "ses_a",
        () => 10,
      ),
    ).toHaveLength(1);
  });

  it("leaves other sessions' requests, and servers not serving yet", () => {
    expect(dueToShow([entry({ opened })], "ses_b", () => undefined)).toEqual(
      [],
    );
    expect(dueToShow([entry({})], "ses_a", () => undefined)).toEqual([]);
    expect(
      dueToShow(
        [
          entry({
            opened,
            status: "starting",
            ports: [],
            primaryPort: undefined,
          }),
        ],
        "ses_a",
        () => undefined,
      ),
    ).toEqual([]);
    expect(
      dueToShow(
        [entry({ opened, status: "killed", ports: [] })],
        "ses_a",
        () => undefined,
      ),
    ).toEqual([]);
  });
});

describe("stoppedServerAt", () => {
  it("names the ended server of a tab's port", () => {
    const killed = entry({ status: "killed", ports: [] });
    expect(stoppedServerAt([killed], "http://localhost:5180/about")?.name).toBe(
      "web",
    );
    expect(stoppedServerAt([killed], "http://127.0.0.1:5180/")?.name).toBe(
      "web",
    );
  });

  it("says nothing while something live serves the port, or for other pages", () => {
    const killed = entry({ status: "killed", ports: [] });
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
