import { describe, expect, it, vi } from "vitest";
import {
  BridgeAttachError,
  BridgeTransport,
  type TokenSource,
} from "./bridge-transport.js";
import type {
  AttachBridgeSessionOptions,
  BridgeSessionHandle,
  CredentialsFailure,
  RemoteCredentials,
} from "./sdk-adapter.js";

const CREDS: RemoteCredentials = {
  worker_jwt: "jwt-1",
  api_base_url: "https://api.anthropic.com",
  expires_in: 14_400,
  worker_epoch: 1,
};

/** A TokenSource that hands out a fixed token (or throws). */
function tokenSource(token = "tok-fresh"): TokenSource {
  return { ensureFresh: vi.fn(async () => token) };
}

/** Build a fake BridgeSessionHandle with controllable connect state. */
function fakeHandle(opts: { connected?: boolean } = {}) {
  let connected = opts.connected ?? true;
  const writes: unknown[] = [];
  let sendResultCalls = 0;
  let closeCalls = 0;
  let seq = 0;
  const h = {
    sessionId: "cse_x",
    getSequenceNum: () => seq,
    isConnected: () => connected,
    write: (m: unknown) => {
      writes.push(m);
      seq++;
    },
    sendResult: () => {
      sendResultCalls++;
    },
    sendControlRequest: vi.fn(),
    sendControlResponse: vi.fn(),
    sendControlCancelRequest: vi.fn(),
    reconnectTransport: vi.fn(async () => {}),
    reportState: vi.fn(),
    reportMetadata: vi.fn(),
    reportDelivery: vi.fn(),
    flush: vi.fn(async () => {}),
    close: () => {
      closeCalls++;
      connected = false;
    },
  } as unknown as BridgeSessionHandle;
  return {
    handle: h,
    writes,
    get sendResultCalls() {
      return sendResultCalls;
    },
    get closeCalls() {
      return closeCalls;
    },
    setConnected(v: boolean) {
      connected = v;
    },
  };
}

/** Default deps wiring a successful create → fetch → attach. Return types are
 *  annotated so individual tests can reassign a member to a different-shaped
 *  mock (e.g. returning null, or reading `opts`) without TS narrowing the
 *  inferred no-arg / non-null signature. */
function happyDeps(handle: BridgeSessionHandle) {
  return {
    createCodeSession: vi.fn(
      async (): Promise<string | null> => "cse_x",
    ),
    fetchRemoteCredentials: vi.fn(
      async (): Promise<RemoteCredentials | CredentialsFailure | null> => CREDS,
    ),
    attachBridgeSession: vi.fn(
      async (_opts: AttachBridgeSessionOptions): Promise<BridgeSessionHandle> =>
        handle,
    ),
  };
}

describe("BridgeTransport.attach — happy path", () => {
  it("runs ensureFresh → create → fetchCreds → attach(outboundOnly) and returns a connected transport", async () => {
    const fake = fakeHandle({ connected: true });
    const deps = happyDeps(fake.handle);
    const tokens = tokenSource();

    const t = await BridgeTransport.attach({
      tokens,
      title: "my session",
      cwd: "/work",
      model: "claude-sonnet-4-6",
      deps,
    });

    expect(tokens.ensureFresh).toHaveBeenCalledOnce();
    // create got the fresh token + default ["sidecode"] tag + cwd + model
    expect(deps.createCodeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "tok-fresh",
        title: "my session",
        tags: ["sidecode"],
        cwd: "/work",
        model: "claude-sonnet-4-6",
      }),
    );
    // fetchCreds got the cse id + token
    expect(deps.fetchRemoteCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "cse_x", accessToken: "tok-fresh" }),
    );
    // attach is outboundOnly with the creds' epoch + jwt
    expect(deps.attachBridgeSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "cse_x",
        apiBaseUrl: CREDS.api_base_url,
        epoch: 1,
        ingressToken: "jwt-1",
        outboundOnly: true,
      }),
    );
    expect(t.cseSessionId).toBe("cse_x");
    expect(t.isConnected).toBe(true);
  });

  it("forwards write / sendResult to the handle; close() is idempotent", async () => {
    const fake = fakeHandle({ connected: true });
    const t = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps: happyDeps(fake.handle),
    });
    t.write({ type: "assistant" });
    t.sendResult();
    expect(fake.writes).toEqual([{ type: "assistant" }]);
    expect(fake.sendResultCalls).toBe(1);

    t.close();
    t.close(); // idempotent
    expect(fake.closeCalls).toBe(1);
    // after close, write/sendResult are no-ops
    t.write({ type: "assistant" });
    t.sendResult();
    expect(fake.writes).toHaveLength(1);
    expect(fake.sendResultCalls).toBe(1);
    expect(t.isConnected).toBe(false);
  });
});

describe("BridgeTransport.attach — error classification", () => {
  it("auth: ensureFresh throws → BridgeAttachError kind=auth, no create attempted", async () => {
    const deps = happyDeps(fakeHandle().handle);
    const tokens: TokenSource = {
      ensureFresh: vi.fn(async () => {
        throw new Error("needs_relogin");
      }),
    };
    const err = await BridgeTransport.attach({
      tokens,
      title: "t",
      cwd: "/w",
      deps,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(BridgeAttachError);
    expect(err.kind).toBe("auth");
    expect(deps.createCodeSession).not.toHaveBeenCalled();
  });

  it("create_failed: createCodeSession returns null → kind=create_failed", async () => {
    const deps = happyDeps(fakeHandle().handle);
    deps.createCodeSession = vi.fn(async () => null);
    const err = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps,
    }).catch((e) => e);
    expect(err.kind).toBe("create_failed");
    expect(deps.fetchRemoteCredentials).not.toHaveBeenCalled();
  });

  it("credentials_failed: fetchRemoteCredentials returns a terminal CredentialsFailure → kind=credentials_failed", async () => {
    const deps = happyDeps(fakeHandle().handle);
    const failure: CredentialsFailure = {
      terminal: true,
      reason: "session_stale_relogin",
    };
    deps.fetchRemoteCredentials = vi.fn(async () => failure);
    const err = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps,
    }).catch((e) => e);
    expect(err.kind).toBe("credentials_failed");
    expect(deps.attachBridgeSession).not.toHaveBeenCalled();
  });

  it("credentials_failed: fetchRemoteCredentials returns null (transport) → kind=credentials_failed", async () => {
    const deps = happyDeps(fakeHandle().handle);
    deps.fetchRemoteCredentials = vi.fn(async () => null);
    const err = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps,
    }).catch((e) => e);
    expect(err.kind).toBe("credentials_failed");
  });

  it("connect_timeout: handle never connects → kind=connect_timeout and handle.close() called", async () => {
    const fake = fakeHandle({ connected: false }); // never flips to connected
    const deps = happyDeps(fake.handle);
    const err = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      connectTimeoutMs: 30,
      connectPollMs: 5,
      deps,
    }).catch((e) => e);
    expect(err.kind).toBe("connect_timeout");
    expect(fake.closeCalls).toBe(1); // cleaned up, no leak
  });

  it("connect_timeout: onClose fires mid-connect → fails fast without waiting the full timeout", async () => {
    const fake = fakeHandle({ connected: false });
    let fireClose: ((code: number) => void) | undefined;
    const deps = happyDeps(fake.handle);
    deps.attachBridgeSession = vi.fn(
      async (opts: AttachBridgeSessionOptions) => {
        fireClose = opts.onClose as (code: number) => void;
        return fake.handle;
      },
    );
    const p = BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      connectTimeoutMs: 10_000, // long — proves we don't wait it out
      connectPollMs: 5,
      deps,
    });
    // Let the first poll iteration run, then simulate a 4090 epoch-supersede.
    await new Promise((r) => setTimeout(r, 10));
    fireClose?.(4090);
    const err = await p.catch((e) => e);
    expect(err.kind).toBe("connect_timeout");
  });
});

describe("BridgeTransport — onClose passthrough", () => {
  it("invokes the caller's onClose with the close code", async () => {
    const fake = fakeHandle({ connected: true });
    let fireClose: ((code: number) => void) | undefined;
    const deps = happyDeps(fake.handle);
    deps.attachBridgeSession = vi.fn(
      async (opts: AttachBridgeSessionOptions) => {
        fireClose = opts.onClose as (code: number) => void;
        return fake.handle;
      },
    );
    const seen: Array<number | undefined> = [];
    await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      onClose: (code) => seen.push(code),
      deps,
    });
    fireClose?.(401);
    expect(seen).toEqual([401]);
  });
});
