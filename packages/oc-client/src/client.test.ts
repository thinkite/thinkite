/**
 * Offline tests for the client wrapper: hey-api URL joining must keep the
 * `/oc` proxy prefix for every method (unary here; SSE is covered by the
 * E2E through the real proxy), and the v1-compat delete shim semantics.
 */

import { describe, expect, it, vi } from "vitest";
import { createOcClient, OcApiError } from "./client.ts";

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return handler(url, init);
  }) as unknown as typeof globalThis.fetch;
}

const SESSION_PAGE = {
  data: [
    {
      id: "ses_1",
      projectID: "p",
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      time: { created: 1, updated: 2 },
      title: "T",
      location: { directory: "/tmp" },
    },
  ],
  cursor: {},
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("oc client", () => {
  it("keeps the /oc prefix on unary methods", async () => {
    const seen: string[] = [];
    const fetch = stubFetch((url) => {
      seen.push(url);
      return json(SESSION_PAGE);
    });
    const client = createOcClient({
      baseUrl: "http://127.0.0.1:5199/oc",
      fetch,
    });
    await client.listSessions({ limit: 10 });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.startsWith("http://127.0.0.1:5199/oc/api/session")).toBe(
      true,
    );
    expect(client.baseUrl).toBe("http://127.0.0.1:5199/oc");
  });

  it("deleteSession hits the v1 compat route and treats 404 as gone", async () => {
    const seen: Array<{ url: string; method?: string }> = [];
    const fetch = stubFetch((url, init) => {
      seen.push({ url, method: init?.method });
      return new Response("true", { status: 404 });
    });
    const client = createOcClient({ baseUrl: "http://x/oc", fetch });
    await client.deleteSession("ses_gone");
    expect(seen[0]).toMatchObject({
      url: "http://x/oc/session/ses_gone",
      method: "DELETE",
    });

    const failing = stubFetch(() => new Response("boom", { status: 500 }));
    const client2 = createOcClient({ baseUrl: "http://x/oc", fetch: failing });
    await expect(client2.deleteSession("ses_1")).rejects.toBeInstanceOf(
      OcApiError,
    );
  });
});
