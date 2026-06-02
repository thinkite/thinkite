import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the @alpha /bridge subpath so we can assert the adapter forwards the
// right positional args + defaults without touching the network.
const sdk = {
  createCodeSession: vi.fn(async () => "cse_test"),
  fetchRemoteCredentials: vi.fn(async () => ({
    worker_jwt: "jwt",
    api_base_url: "https://api",
    expires_in: 14_400,
    worker_epoch: 1,
  })),
  attachBridgeSession: vi.fn(async () => ({ isConnected: () => true })),
  isCredentialsFailure: vi.fn(() => false),
};
vi.mock("@anthropic-ai/claude-agent-sdk/bridge", () => sdk);

const {
  ANTHROPIC_API_BASE,
  DEFAULT_BRIDGE_TIMEOUT_MS,
  attachBridgeSession,
  createCodeSession,
  deleteCodeSession,
  fetchRemoteCredentials,
  isCredentialsFailure,
} = await import("./sdk-adapter.js");

beforeEach(() => {
  for (const fn of Object.values(sdk)) fn.mockClear();
});

describe("createCodeSession adapter", () => {
  it("forwards object-args to the positional SDK call with host + timeout defaults", async () => {
    await createCodeSession({
      accessToken: "tok",
      title: "sidecode-x",
      tags: ["sidecode"],
      cwd: "/work",
      model: "claude-sonnet-4-6",
    });
    expect(sdk.createCodeSession).toHaveBeenCalledWith(
      ANTHROPIC_API_BASE,
      "tok",
      "sidecode-x",
      DEFAULT_BRIDGE_TIMEOUT_MS,
      ["sidecode"],
      undefined, // gitContext
      "/work",
      "claude-sonnet-4-6",
    );
  });

  it("honors explicit baseUrl + timeout overrides", async () => {
    await createCodeSession({
      accessToken: "tok",
      title: "t",
      baseUrl: "http://localhost:8000",
      timeoutMs: 5_000,
    });
    expect(sdk.createCodeSession).toHaveBeenCalledWith(
      "http://localhost:8000",
      "tok",
      "t",
      5_000,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  });
});

describe("fetchRemoteCredentials adapter", () => {
  it("forwards object-args with defaults and trusted-device passthrough", async () => {
    await fetchRemoteCredentials({
      sessionId: "cse_1",
      accessToken: "tok",
      trustedDeviceToken: "tdt",
    });
    expect(sdk.fetchRemoteCredentials).toHaveBeenCalledWith(
      "cse_1",
      ANTHROPIC_API_BASE,
      "tok",
      DEFAULT_BRIDGE_TIMEOUT_MS,
      "tdt",
    );
  });
});

describe("pass-through wrappers", () => {
  it("attachBridgeSession forwards the options object verbatim", async () => {
    const opts = {
      sessionId: "cse_1",
      apiBaseUrl: "x",
      epoch: 1,
      ingressToken: "j",
    };
    await attachBridgeSession(opts);
    expect(sdk.attachBridgeSession).toHaveBeenCalledWith(opts);
  });

  it("isCredentialsFailure delegates to the SDK guard", () => {
    const failure = { terminal: true, reason: "untrusted_device" } as const;
    isCredentialsFailure(failure);
    expect(sdk.isCredentialsFailure).toHaveBeenCalledWith(failure);
  });
});

describe("deleteCodeSession (raw HTTP, no SDK fn)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("DELETEs the cse_ with Bearer + version + org headers, NO beta; true on 200", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const ok = await deleteCodeSession({
      sessionId: "cse_9",
      accessToken: "tok",
      organizationUuid: "org_1",
    });
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${ANTHROPIC_API_BASE}/v1/code/sessions/cse_9`);
    expect(init.method).toBe("DELETE");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer tok",
      "anthropic-version": "2023-06-01",
      "x-organization-uuid": "org_1",
    });
    expect(init.headers).not.toHaveProperty("anthropic-beta");
  });

  it("treats 404 as success (idempotent — already gone)", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("", { status: 404 }),
    ) as unknown as typeof fetch;
    await expect(
      deleteCodeSession({
        sessionId: "cse_x",
        accessToken: "t",
        organizationUuid: "o",
      }),
    ).resolves.toBe(true);
  });

  it("returns false on 500 and never throws on network error", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("", { status: 500 }),
    ) as unknown as typeof fetch;
    await expect(
      deleteCodeSession({
        sessionId: "cse_x",
        accessToken: "t",
        organizationUuid: "o",
      }),
    ).resolves.toBe(false);

    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    await expect(
      deleteCodeSession({
        sessionId: "cse_x",
        accessToken: "t",
        organizationUuid: "o",
      }),
    ).resolves.toBe(false);
  });

  it("honors baseUrl override", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response("{}", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await deleteCodeSession({
      sessionId: "cse_1",
      accessToken: "t",
      organizationUuid: "o",
      baseUrl: "http://localhost:8000",
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://localhost:8000/v1/code/sessions/cse_1",
    );
  });
});
