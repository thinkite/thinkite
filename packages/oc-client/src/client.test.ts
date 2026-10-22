/**
 * Client wrapper tests: the `/oc` path prefix is inserted on every route
 * (the generated client resolves against the origin), Basic auth is
 * derived from the password, and paging arguments follow the server's
 * "cursor xor order" rule.
 */

import { describe, expect, it } from "vitest";
import { createOcClient } from "./client.ts";

function capture(body: unknown = { data: [], cursor: {} }) {
  const calls: Array<{ url: string; auth: string | null; method: string }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
      auth: headers.get("authorization"),
      method: init?.method ?? "GET",
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("oc client", () => {
  it("keeps the mount prefix on routes and injects Basic auth", async () => {
    const { fetchImpl, calls } = capture({ version: "2.1.2" });
    const client = createOcClient({
      baseUrl: "http://localhost:5183",
      pathPrefix: "/oc",
      password: "pw",
      fetch: fetchImpl,
    });
    await client.info();
    expect(calls[0]?.url).toMatch(/^http:\/\/localhost:5183\/oc\/api\//);
    expect(calls[0]?.auth).toBe(`Basic ${btoa("opencode:pw")}`);
  });

  it("asks for desc order on the first page and only the cursor afterwards", async () => {
    const { fetchImpl, calls } = capture();
    const client = createOcClient({ baseUrl: "http://h", fetch: fetchImpl });
    await client.listMessages("ses_a", { limit: 20 });
    await client.listMessages("ses_a", { limit: 20, cursor: "c1" });
    await client.listSessions({ limit: 50 });
    const urls = calls.map((c) => new URL(c.url));
    expect(urls[0]?.pathname).toBe("/api/session/ses_a/message");
    expect(urls[0]?.searchParams.get("order")).toBe("desc");
    expect(urls[0]?.searchParams.get("cursor")).toBeNull();
    expect(urls[1]?.searchParams.get("cursor")).toBe("c1");
    expect(urls[1]?.searchParams.get("order")).toBeNull();
    expect(urls[2]?.pathname).toBe("/api/session");
    expect(urls[2]?.searchParams.get("limit")).toBe("50");
  });

  it("maps active drains to a set of session ids", async () => {
    const { fetchImpl } = capture({ data: { ses_a: { type: "running" } } });
    const client = createOcClient({ baseUrl: "http://h", fetch: fetchImpl });
    expect(await client.activeSessionIDs()).toEqual(new Set(["ses_a"]));
  });
});
