import { describe, expect, it, vi } from "vitest";
import { OAuthRefreshError } from "./bridge/oauth-refresh.js";
import { createPlanUsageFetcher, parsePlanUsage } from "./plan-usage.js";

// createPlanUsageFetcher only calls `ensureFresh()` on the manager — a
// stub with that one method is a faithful stand-in.
function oauthStub(impl: () => Promise<string>) {
  return { ensureFresh: impl } as unknown as Parameters<
    typeof createPlanUsageFetcher
  >[0];
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// Values are 0..100 percentages, matching the live endpoint (71 = 71%).
const FULL_BODY = {
  five_hour: { utilization: 91, resets_at: "2026-06-11T09:00:00Z" },
  seven_day: { utilization: 99, resets_at: "2026-06-15T00:00:00Z" },
  seven_day_opus: { utilization: 45 },
  seven_day_sonnet: { utilization: 12, resets_at: "2026-06-15T00:00:00Z" },
  // Unknown windows must be ignored, not break parsing.
  seven_day_design: { utilization: 50 },
};

describe("parsePlanUsage", () => {
  it("maps the documented window keys and passes fetchedAt through", () => {
    const usage = parsePlanUsage(FULL_BODY, 1234);
    expect(usage.fiveHour).toEqual({
      utilization: 91,
      resetsAt: "2026-06-11T09:00:00Z",
    });
    expect(usage.sevenDay?.utilization).toBe(99);
    expect(usage.sevenDayOpus).toEqual({
      utilization: 45,
      resetsAt: undefined,
    });
    expect(usage.sevenDaySonnet?.utilization).toBe(12);
    expect(usage.fetchedAt).toBe(1234);
  });

  it("treats absent / malformed windows as unavailable, never 0%", () => {
    // Enterprise/org accounts return partial or null windows.
    const usage = parsePlanUsage(
      { five_hour: null, seven_day: { utilization: "0.5" } },
      0,
    );
    expect(usage.fiveHour).toBeUndefined();
    expect(usage.sevenDay).toBeUndefined();
  });

  it("survives a non-object body", () => {
    expect(parsePlanUsage(null, 0).fiveHour).toBeUndefined();
    expect(parsePlanUsage("nope", 0).fiveHour).toBeUndefined();
  });
});

describe("createPlanUsageFetcher", () => {
  it("ok path: fetches with bearer + beta header, returns parsed usage", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(FULL_BODY));
    const fetcher = createPlanUsageFetcher(
      oauthStub(() => Promise.resolve("tok-123")),
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => 1000 },
    );
    const result = await fetcher();
    if (result.status !== "ok") throw new Error(`got ${result.status}`);
    expect(result.usage.fiveHour?.utilization).toBe(91);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("/api/oauth/usage");
    expect(init.headers.Authorization).toBe("Bearer tok-123");
    expect(init.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });

  it("serves from cache within the TTL (no second hit)", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse(FULL_BODY));
    let t = 1000;
    const fetcher = createPlanUsageFetcher(
      oauthStub(() => Promise.resolve("tok")),
      { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t },
    );
    await fetcher();
    t += 10_000; // inside the 30s TTL
    await fetcher();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t += 60_000; // past the TTL
    fetchImpl.mockResolvedValue(okResponse(FULL_BODY));
    await fetcher();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("no_credentials / needs_relogin → signed_out", async () => {
    for (const kind of ["no_credentials", "needs_relogin"] as const) {
      const fetcher = createPlanUsageFetcher(
        oauthStub(() => Promise.reject(new OAuthRefreshError(kind, kind))),
        { fetchImpl: vi.fn() as unknown as typeof fetch },
      );
      expect((await fetcher()).status).toBe("signed_out");
    }
  });

  it("network refresh error → error (retryable), not signed_out", async () => {
    const fetcher = createPlanUsageFetcher(
      oauthStub(() => Promise.reject(new OAuthRefreshError("network", "boom"))),
      { fetchImpl: vi.fn() as unknown as typeof fetch },
    );
    expect((await fetcher()).status).toBe("error");
  });

  it("endpoint 401 → signed_out; other non-2xx → error", async () => {
    const mk = (status: number) =>
      createPlanUsageFetcher(
        oauthStub(() => Promise.resolve("tok")),
        {
          fetchImpl: vi
            .fn()
            .mockResolvedValue(
              new Response("{}", { status }),
            ) as unknown as typeof fetch,
        },
      );
    expect((await mk(401)()).status).toBe("signed_out");
    expect((await mk(429)()).status).toBe("error");
    expect((await mk(500)()).status).toBe("error");
  });

  it("concurrent calls share one in-flight request", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    const fetchImpl = vi.fn().mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const fetcher = createPlanUsageFetcher(
      oauthStub(() => Promise.resolve("tok")),
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    const [a, b] = [fetcher(), fetcher()];
    resolveFetch(okResponse(FULL_BODY));
    const [ra, rb] = await Promise.all([a, b]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(ra.status).toBe("ok");
    expect(rb.status).toBe("ok");
  });
});
