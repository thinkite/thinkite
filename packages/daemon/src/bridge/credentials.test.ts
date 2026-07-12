import { describe, expect, it } from "vitest";
import {
  fallbackStore,
  readCredentials,
  type SecureStore,
  writeCredentials,
} from "./credentials.ts";

/** In-memory SecureStore for tests. */
function memStore(initial: string | null = null): SecureStore & {
  value: string | null;
} {
  return {
    value: initial,
    get() {
      return this.value;
    },
    set(v: string) {
      this.value = v;
      return true;
    },
  };
}

const WRAPPED = JSON.stringify({
  claudeAiOauth: {
    accessToken: "at-1",
    refreshToken: "rt-1",
    expiresAt: 1_000,
    scopes: ["user:profile", "user:inference"],
    subscriptionType: "max",
    rateLimitTier: "tier-x",
    // an unknown field the binary/Desktop might write
    someFutureField: { a: 1 },
  },
});

describe("readCredentials", () => {
  it("parses the wrapped { claudeAiOauth } envelope", () => {
    const creds = readCredentials(memStore(WRAPPED));
    expect(creds).toEqual({
      accessToken: "at-1",
      refreshToken: "rt-1",
      expiresAt: 1_000,
      scopes: ["user:profile", "user:inference"],
      subscriptionType: "max",
      rateLimitTier: "tier-x",
    });
  });

  it("parses a root-level object (no envelope)", () => {
    const raw = JSON.stringify({
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: 2_000,
      scopes: [],
    });
    const creds = readCredentials(memStore(raw));
    expect(creds?.accessToken).toBe("at-2");
    expect(creds?.expiresAt).toBe(2_000);
    expect(creds?.scopes).toEqual([]);
    expect(creds?.subscriptionType).toBeNull();
  });

  it("returns null on empty store / malformed JSON / missing fields", () => {
    expect(readCredentials(memStore(null))).toBeNull();
    expect(readCredentials(memStore("not json"))).toBeNull();
    expect(
      readCredentials(memStore(JSON.stringify({ claudeAiOauth: {} }))),
    ).toBeNull();
    expect(
      readCredentials(
        memStore(JSON.stringify({ claudeAiOauth: { accessToken: "x" } })),
      ),
    ).toBeNull(); // refreshToken missing
  });

  it("defaults expiresAt to 0 when absent (forces a refresh)", () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: "a", refreshToken: "r", scopes: [] },
    });
    expect(readCredentials(memStore(raw))?.expiresAt).toBe(0);
  });
});

describe("writeCredentials", () => {
  it("preserves the envelope and unknown inner fields on writeback", () => {
    const store = memStore(WRAPPED);
    writeCredentials(
      {
        accessToken: "at-NEW",
        refreshToken: "rt-NEW",
        expiresAt: 9_999,
        scopes: ["user:profile"],
        subscriptionType: "max",
        rateLimitTier: "tier-x",
      },
      store,
    );
    const parsed = JSON.parse(store.value as string);
    // still wrapped
    expect(parsed).toHaveProperty("claudeAiOauth");
    // token fields updated
    expect(parsed.claudeAiOauth.accessToken).toBe("at-NEW");
    expect(parsed.claudeAiOauth.refreshToken).toBe("rt-NEW");
    expect(parsed.claudeAiOauth.expiresAt).toBe(9_999);
    // unknown field NOT clobbered
    expect(parsed.claudeAiOauth.someFutureField).toEqual({ a: 1 });
  });

  it("round-trips through readCredentials", () => {
    const store = memStore(WRAPPED);
    const next = {
      accessToken: "at-2",
      refreshToken: "rt-2",
      expiresAt: 5_000,
      scopes: ["user:inference"],
      subscriptionType: "pro",
      rateLimitTier: null,
    };
    writeCredentials(next, store);
    expect(readCredentials(store)).toEqual(next);
  });

  it("writes a wrapped envelope when the store was empty", () => {
    const store = memStore(null);
    writeCredentials(
      {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
        scopes: [],
      },
      store,
    );
    expect(JSON.parse(store.value as string)).toHaveProperty("claudeAiOauth");
  });

  it("keeps a root-level (unwrapped) shape when the existing blob was unwrapped", () => {
    const store = memStore(
      JSON.stringify({
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
        scopes: [],
      }),
    );
    writeCredentials(
      { accessToken: "a2", refreshToken: "r2", expiresAt: 2, scopes: [] },
      store,
    );
    const parsed = JSON.parse(store.value as string);
    expect(parsed).not.toHaveProperty("claudeAiOauth");
    expect(parsed.accessToken).toBe("a2");
  });
});

describe("fallbackStore", () => {
  it("reads from primary when present, else secondary", () => {
    expect(fallbackStore(memStore("P"), memStore("S")).get()).toBe("P");
    expect(fallbackStore(memStore(null), memStore("S")).get()).toBe("S");
  });

  it("set succeeds if either store accepts the write", () => {
    const failing: SecureStore = { get: () => null, set: () => false };
    const ok = memStore(null);
    expect(fallbackStore(failing, ok).set("v")).toBe(true);
    expect(ok.value).toBe("v");
    expect(fallbackStore(failing, failing).set("v")).toBe(false);
  });
});
