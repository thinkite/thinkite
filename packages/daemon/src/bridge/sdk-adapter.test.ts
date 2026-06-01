import { beforeEach, describe, expect, it, vi } from "vitest";

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
