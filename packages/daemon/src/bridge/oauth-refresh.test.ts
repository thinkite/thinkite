import { describe, expect, it, vi } from "vitest";
import { type SecureStore } from "./credentials.js";
import {
  OAuthRefreshError,
  OAuthRefreshManager,
} from "./oauth-refresh.js";

const NOW = 1_000_000_000_000; // fixed clock base

/** In-memory store seeded with a wrapped credential blob. */
function memStore(inner: Record<string, unknown>): SecureStore & {
  value: string | null;
} {
  return {
    value: JSON.stringify({ claudeAiOauth: inner }),
    get() {
      return this.value;
    },
    set(v: string) {
      this.value = v;
      return true;
    },
  };
}

/** A fetch stub returning a 200 token-refresh body. */
function okFetch(body: {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  })) as unknown as typeof fetch;
}

/** A fetch stub returning a non-2xx. */
function errFetch(status: number, body: string): typeof fetch {
  return vi.fn(async () => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
  })) as unknown as typeof fetch;
}

describe("ensureFresh", () => {
  it("returns the current token unchanged when far from expiry (no fetch)", async () => {
    const fetchImpl = okFetch({ access_token: "should-not-be-used" });
    const mgr = new OAuthRefreshManager({
      store: memStore({
        accessToken: "at-current",
        refreshToken: "rt",
        expiresAt: NOW + 60 * 60_000, // 1h out
        scopes: ["user:inference"],
      }),
      fetchImpl,
      now: () => NOW,
    });
    expect(await mgr.ensureFresh()).toBe("at-current");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refreshes when within the expiry buffer and writes back the rotated token", async () => {
    const store = memStore({
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: NOW + 60_000, // 1min out → inside the 5min buffer
      scopes: ["user:inference"],
      subscriptionType: "max",
    });
    const fetchImpl = okFetch({
      access_token: "at-new",
      refresh_token: "rt-new",
      expires_in: 86_400,
      scope: "user:inference user:profile",
    });
    const mgr = new OAuthRefreshManager({ store, fetchImpl, now: () => NOW });

    expect(await mgr.ensureFresh()).toBe("at-new");

    const persisted = JSON.parse(store.value as string).claudeAiOauth;
    expect(persisted.accessToken).toBe("at-new");
    expect(persisted.refreshToken).toBe("rt-new"); // rotation persisted
    expect(persisted.expiresAt).toBe(NOW + 86_400 * 1000);
    expect(persisted.scopes).toEqual(["user:inference", "user:profile"]);
    expect(persisted.subscriptionType).toBe("max"); // preserved
  });

  it("throws no_credentials when the store is empty", async () => {
    const empty: SecureStore = { get: () => null, set: () => true };
    const mgr = new OAuthRefreshManager({ store: empty, now: () => NOW });
    await expect(mgr.ensureFresh()).rejects.toMatchObject({
      kind: "no_credentials",
    });
  });

  it("coalesces concurrent refreshes into one fetch", async () => {
    const fetchImpl = okFetch({
      access_token: "at-new",
      refresh_token: "rt-new",
      expires_in: 86_400,
    });
    const mgr = new OAuthRefreshManager({
      store: memStore({
        accessToken: "at-old",
        refreshToken: "rt-old",
        expiresAt: NOW, // expired → forces refresh
        scopes: [],
      }),
      fetchImpl,
      now: () => NOW,
    });
    const [a, b] = await Promise.all([mgr.ensureFresh(), mgr.ensureFresh()]);
    expect(a).toBe("at-new");
    expect(b).toBe("at-new");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("falls back to the old refresh token when the server doesn't rotate", async () => {
    const store = memStore({
      accessToken: "at-old",
      refreshToken: "rt-keep",
      expiresAt: NOW,
      scopes: [],
    });
    const mgr = new OAuthRefreshManager({
      store,
      fetchImpl: okFetch({ access_token: "at-new", expires_in: 3600 }),
      now: () => NOW,
    });
    await mgr.ensureFresh();
    expect(JSON.parse(store.value as string).claudeAiOauth.refreshToken).toBe(
      "rt-keep",
    );
  });

  it("defaults expiry to 1h (not 0) when the server omits/zeroes expires_in", async () => {
    // A 0/absent expires_in must NOT make the new token instantly-expired
    // (that would refresh-storm on the next ensureFresh). Test both shapes.
    for (const body of [
      { access_token: "at-new", refresh_token: "rt-new" }, // omitted
      { access_token: "at-new", refresh_token: "rt-new", expires_in: 0 }, // zero
    ]) {
      const store = memStore({
        accessToken: "at-old",
        refreshToken: "rt-old",
        expiresAt: NOW, // expired → forces refresh
        scopes: [],
      });
      const mgr = new OAuthRefreshManager({
        store,
        fetchImpl: okFetch(body),
        now: () => NOW,
      });
      await mgr.ensureFresh();
      expect(JSON.parse(store.value as string).claudeAiOauth.expiresAt).toBe(
        NOW + 3600 * 1000,
      );
    }
  });
});

describe("invalid_grant handling", () => {
  it("re-reads the store and uses a fresher token written by another client", async () => {
    const store = memStore({
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: NOW, // expired
      scopes: [],
    });
    // fetch fails with invalid_grant, but BEFORE the failure resolves we
    // simulate CLI/Desktop having rotated the keychain to a fresh token.
    const fetchImpl = vi.fn(async () => {
      store.value = JSON.stringify({
        claudeAiOauth: {
          accessToken: "at-from-cli",
          refreshToken: "rt-from-cli",
          expiresAt: NOW + 60 * 60_000,
          scopes: [],
        },
      });
      return {
        ok: false,
        status: 400,
        json: async () => ({}),
        text: async () => '{"error":"invalid_grant"}',
      };
    }) as unknown as typeof fetch;

    const mgr = new OAuthRefreshManager({ store, fetchImpl, now: () => NOW });
    expect(await mgr.ensureFresh()).toBe("at-from-cli");
  });

  it("throws needs_relogin when invalid_grant and no fresher token exists", async () => {
    const mgr = new OAuthRefreshManager({
      store: memStore({
        accessToken: "at-old",
        refreshToken: "rt-old",
        expiresAt: NOW,
        scopes: [],
      }),
      fetchImpl: errFetch(400, '{"error":"invalid_grant"}'),
      now: () => NOW,
    });
    await expect(mgr.ensureFresh()).rejects.toMatchObject({
      kind: "needs_relogin",
    });
  });

  it("throws network on a non-invalid_grant error", async () => {
    const mgr = new OAuthRefreshManager({
      store: memStore({
        accessToken: "at-old",
        refreshToken: "rt-old",
        expiresAt: NOW,
        scopes: [],
      }),
      fetchImpl: errFetch(503, "service unavailable"),
      now: () => NOW,
    });
    const err = await mgr.ensureFresh().catch((e) => e);
    expect(err).toBeInstanceOf(OAuthRefreshError);
    expect(err.kind).toBe("network");
  });
});

describe("proactive timer", () => {
  it("start() schedules ahead of expiry; firing it refreshes the token", async () => {
    const store = memStore({
      accessToken: "at-old",
      refreshToken: "rt-old",
      expiresAt: NOW + 2 * 60 * 60_000, // 2h out
      scopes: [],
    });
    const calls: Array<{ cb: () => void; ms: number }> = [];
    const setTimer = vi.fn((cb: () => void, ms: number) => {
      calls.push({ cb, ms });
      return { unref() {} };
    });
    const clearTimer = vi.fn();
    const fetchImpl = okFetch({
      access_token: "at-new",
      refresh_token: "rt-new",
      expires_in: 86_400,
    });
    const mgr = new OAuthRefreshManager({
      store,
      fetchImpl,
      now: () => NOW,
      setTimer,
      clearTimer,
    });

    mgr.start();
    expect(setTimer).toHaveBeenCalledTimes(1);
    // fires 30min before expiry: 2h - 30min = 90min
    expect(calls[0]?.ms).toBe(90 * 60_000);

    // Fire the timer manually, then let the async refresh settle.
    calls[0]?.cb();
    await vi.waitFor(() =>
      expect(JSON.parse(store.value as string).claudeAiOauth.accessToken).toBe(
        "at-new",
      ),
    );

    mgr.stop();
  });

  it("stop() cancels the pending timer", () => {
    const clearTimer = vi.fn();
    const mgr = new OAuthRefreshManager({
      store: memStore({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: NOW + 60 * 60_000,
        scopes: [],
      }),
      now: () => NOW,
      setTimer: () => ({ unref() {} }),
      clearTimer,
    });
    mgr.start();
    mgr.stop();
    expect(clearTimer).toHaveBeenCalledTimes(1);
  });

  it("does not schedule before start()", () => {
    const setTimer = vi.fn(() => ({ unref() {} }));
    new OAuthRefreshManager({
      store: memStore({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: NOW,
        scopes: [],
      }),
      now: () => NOW,
      setTimer,
    });
    expect(setTimer).not.toHaveBeenCalled();
  });
});
