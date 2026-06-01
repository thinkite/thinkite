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
    createCodeSession: vi.fn(async (): Promise<string | null> => "cse_x"),
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

describe("BridgeTransport.attach — inbound (M2 read-in)", () => {
  it("passing inbound flips outboundOnly:false and wires onInboundMessage/onInterrupt/onSetModel", async () => {
    const fake = fakeHandle({ connected: true });
    let captured: AttachBridgeSessionOptions | undefined;
    const deps = happyDeps(fake.handle);
    deps.attachBridgeSession = vi.fn(
      async (opts: AttachBridgeSessionOptions) => {
        captured = opts;
        return fake.handle;
      },
    );
    const seen: string[] = [];
    const onInboundMessage = vi.fn((m: unknown) => {
      seen.push(`msg:${JSON.stringify(m)}`);
    });
    const onInterrupt = vi.fn(() => {
      seen.push("interrupt");
    });
    const onSetModel = vi.fn((model: string | undefined) => {
      seen.push(`model:${model}`);
    });

    await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      inbound: { onInboundMessage, onInterrupt, onSetModel },
      deps,
    });

    expect(captured?.outboundOnly).toBe(false);
    // The SDK invokes the wired handlers → they call through to ours.
    captured?.onInboundMessage?.({ type: "user" } as never);
    captured?.onInterrupt?.();
    captured?.onSetModel?.("claude-opus-4-7");
    expect(seen).toEqual([
      'msg:{"type":"user"}',
      "interrupt",
      "model:claude-opus-4-7",
    ]);
  });

  it("omitting inbound keeps outboundOnly:true (mirror) and wires no inbound handlers", async () => {
    const fake = fakeHandle({ connected: true });
    let captured: AttachBridgeSessionOptions | undefined;
    const deps = happyDeps(fake.handle);
    deps.attachBridgeSession = vi.fn(
      async (opts: AttachBridgeSessionOptions) => {
        captured = opts;
        return fake.handle;
      },
    );
    await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps,
    });
    expect(captured?.outboundOnly).toBe(true);
    expect(captured?.onInboundMessage).toBeUndefined();
    expect(captured?.onInterrupt).toBeUndefined();
    expect(captured?.onSetModel).toBeUndefined();
  });

  it("explicit outboundOnly overrides the inbound-derived default", async () => {
    const fake = fakeHandle({ connected: true });
    let captured: AttachBridgeSessionOptions | undefined;
    const deps = happyDeps(fake.handle);
    deps.attachBridgeSession = vi.fn(
      async (opts: AttachBridgeSessionOptions) => {
        captured = opts;
        return fake.handle;
      },
    );
    // inbound present but the caller forces mirror — the explicit flag wins.
    await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      inbound: { onInboundMessage: vi.fn() },
      outboundOnly: true,
      deps,
    });
    expect(captured?.outboundOnly).toBe(true);
    // The handler is still forwarded (the SDK ignores inbound in outbound-only
    // mode; the transport doesn't second-guess the explicit flag).
    expect(captured?.onInboundMessage).toBeDefined();
  });

  it("partial inbound (only onInboundMessage) wires just that handler", async () => {
    const fake = fakeHandle({ connected: true });
    let captured: AttachBridgeSessionOptions | undefined;
    const deps = happyDeps(fake.handle);
    deps.attachBridgeSession = vi.fn(
      async (opts: AttachBridgeSessionOptions) => {
        captured = opts;
        return fake.handle;
      },
    );
    await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      inbound: { onInboundMessage: vi.fn() },
      deps,
    });
    expect(captured?.outboundOnly).toBe(false);
    expect(captured?.onInboundMessage).toBeDefined();
    expect(captured?.onInterrupt).toBeUndefined();
    expect(captured?.onSetModel).toBeUndefined();
    expect(captured?.onSetPermissionMode).toBeUndefined();
  });

  it("wires onSetPermissionMode and forwards the verdict from the caller's handler", async () => {
    const fake = fakeHandle({ connected: true });
    let captured: AttachBridgeSessionOptions | undefined;
    const deps = happyDeps(fake.handle);
    deps.attachBridgeSession = vi.fn(
      async (opts: AttachBridgeSessionOptions) => {
        captured = opts;
        return fake.handle;
      },
    );
    const onSetPermissionMode = vi.fn(() => ({
      ok: false as const,
      error: "test-refuse",
    }));
    await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      inbound: { onSetPermissionMode },
      deps,
    });
    expect(captured?.outboundOnly).toBe(false);
    expect(captured?.onSetPermissionMode).toBeDefined();
    // The wrapper preserves the caller's verdict verbatim.
    const verdict = captured?.onSetPermissionMode?.("plan" as never);
    expect(verdict).toEqual({ ok: false, error: "test-refuse" });
    expect(onSetPermissionMode).toHaveBeenCalledWith("plan");
  });

  it("a throwing onSetPermissionMode is wrapped to a generic error verdict (server never hangs)", async () => {
    const fake = fakeHandle({ connected: true });
    let captured: AttachBridgeSessionOptions | undefined;
    const deps = happyDeps(fake.handle);
    deps.attachBridgeSession = vi.fn(
      async (opts: AttachBridgeSessionOptions) => {
        captured = opts;
        return fake.handle;
      },
    );
    await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      inbound: {
        onSetPermissionMode: () => {
          throw new Error("boom-perm-mode");
        },
      },
      deps,
    });
    // Must return a value (NOT throw) — the SDK forwards the verdict as the
    // control_response; throwing would leave the server hanging on the request.
    const verdict = captured?.onSetPermissionMode?.("plan" as never);
    expect(verdict).toEqual({
      ok: false,
      error: "set_permission_mode handler threw",
    });
  });

  it("a throwing inbound handler is swallowed (never propagates into the SSE loop)", async () => {
    const fake = fakeHandle({ connected: true });
    let captured: AttachBridgeSessionOptions | undefined;
    const deps = happyDeps(fake.handle);
    deps.attachBridgeSession = vi.fn(
      async (opts: AttachBridgeSessionOptions) => {
        captured = opts;
        return fake.handle;
      },
    );
    await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      inbound: {
        onInboundMessage: () => {
          throw new Error("boom-sync");
        },
        onInterrupt: () => {
          throw new Error("boom-interrupt");
        },
        onSetModel: () => {
          throw new Error("boom-model");
        },
      },
      deps,
    });
    // None of these should throw — the transport wraps each handler.
    expect(() =>
      captured?.onInboundMessage?.({ type: "user" } as never),
    ).not.toThrow();
    expect(() => captured?.onInterrupt?.()).not.toThrow();
    expect(() => captured?.onSetModel?.("x")).not.toThrow();
  });

  it("a rejecting async onInboundMessage doesn't surface an unhandled rejection", async () => {
    const fake = fakeHandle({ connected: true });
    let captured: AttachBridgeSessionOptions | undefined;
    const deps = happyDeps(fake.handle);
    deps.attachBridgeSession = vi.fn(
      async (opts: AttachBridgeSessionOptions) => {
        captured = opts;
        return fake.handle;
      },
    );
    await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      inbound: {
        onInboundMessage: async () => {
          throw new Error("boom-async");
        },
      },
      deps,
    });
    // The wrapper attaches a .catch to the returned promise → no unhandled
    // rejection, and the call itself returns void synchronously.
    expect(() =>
      captured?.onInboundMessage?.({ type: "user" } as never),
    ).not.toThrow();
    // Give the microtask queue a tick to settle the rejected promise.
    await Promise.resolve();
  });
});

describe("BridgeTransport.checkpoint — M3.1 SSE high-water persist", () => {
  it("invokes persistSequenceNum with handle.getSequenceNum() each call", async () => {
    const fake = fakeHandle({ connected: true });
    const persistSequenceNum = vi.fn();
    const transport = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      persistSequenceNum,
      deps: happyDeps(fake.handle),
    });
    // fakeHandle bumps seq on each write — simulate two inbounds.
    transport.write({ type: "user" });
    transport.write({ type: "assistant" });
    transport.checkpoint();
    expect(persistSequenceNum).toHaveBeenCalledWith(2);
  });

  it("is a no-op after close (a stale tap fire mustn't write past tear-down)", async () => {
    const fake = fakeHandle({ connected: true });
    const persistSequenceNum = vi.fn();
    const transport = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      persistSequenceNum,
      deps: happyDeps(fake.handle),
    });
    transport.write({ type: "user" });
    transport.close();
    transport.checkpoint();
    expect(persistSequenceNum).not.toHaveBeenCalled();
  });

  it("is a no-op when no persistSequenceNum callback was supplied (spike attach)", async () => {
    const fake = fakeHandle({ connected: true });
    const transport = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      // no persistSequenceNum — mimics a M1.5 / M2.5 spike attach
      deps: happyDeps(fake.handle),
    });
    transport.write({ type: "user" });
    expect(() => transport.checkpoint()).not.toThrow();
  });

  it("swallows persistSequenceNum throw (best-effort, never breaks the tap)", async () => {
    const fake = fakeHandle({ connected: true });
    const persistSequenceNum = vi.fn(() => {
      throw new Error("disk full");
    });
    const transport = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      persistSequenceNum,
      deps: happyDeps(fake.handle),
    });
    transport.write({ type: "user" });
    expect(() => transport.checkpoint()).not.toThrow();
    expect(persistSequenceNum).toHaveBeenCalled();
  });
});

describe("BridgeTransport.reportMetadata — #17 model broadcast to CCR", () => {
  it("forwards metadata verbatim to handle.reportMetadata", async () => {
    const fake = fakeHandle({ connected: true });
    const t = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps: happyDeps(fake.handle),
    });
    t.reportMetadata({ model: "claude-opus-4-7" });
    expect(fake.handle.reportMetadata).toHaveBeenCalledExactlyOnceWith({
      model: "claude-opus-4-7",
    });
  });

  it("is a no-op after close — stale callbacks must not touch the SDK handle", async () => {
    const fake = fakeHandle({ connected: true });
    const t = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps: happyDeps(fake.handle),
    });
    t.close();
    t.reportMetadata({ model: "x" });
    expect(fake.handle.reportMetadata).not.toHaveBeenCalled();
  });

  it("swallows handle exceptions — best-effort, mustn't break the RPC response path", async () => {
    const fake = fakeHandle({ connected: true });
    fake.handle.reportMetadata = vi.fn(() => {
      throw new Error("CCR transport flaky");
    });
    const t = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps: happyDeps(fake.handle),
    });
    expect(() => t.reportMetadata({ model: "x" })).not.toThrow();
  });
});

describe("BridgeTransport.reconnect — M3.5.2 transport-level credential swap", () => {
  it("delegates to handle.reconnectTransport with the passed ingress + epoch", async () => {
    const fake = fakeHandle({ connected: true });
    const reconnectSpy = vi.fn(async () => {});
    fake.handle.reconnectTransport = reconnectSpy;
    const transport = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps: happyDeps(fake.handle),
    });
    await transport.reconnect({
      ingressToken: "new-jwt-7",
      apiBaseUrl: "https://api.anthropic.com",
      epoch: 5,
    });
    expect(reconnectSpy).toHaveBeenCalledWith({
      ingressToken: "new-jwt-7",
      apiBaseUrl: "https://api.anthropic.com",
      epoch: 5,
    });
  });

  it("propagates the underlying handle.reconnectTransport rejection (caller decides retry)", async () => {
    const fake = fakeHandle({ connected: true });
    fake.handle.reconnectTransport = vi.fn(async () => {
      throw new Error("server 5xx");
    });
    const transport = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps: happyDeps(fake.handle),
    });
    await expect(
      transport.reconnect({
        ingressToken: "x",
        apiBaseUrl: "https://api.anthropic.com",
        epoch: 1,
      }),
    ).rejects.toThrow("server 5xx");
  });

  it("throws when called after close (reconnecting a torn-down transport is a programmer bug)", async () => {
    const fake = fakeHandle({ connected: true });
    const transport = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps: happyDeps(fake.handle),
    });
    transport.close();
    await expect(
      transport.reconnect({
        ingressToken: "x",
        apiBaseUrl: "https://api.anthropic.com",
        epoch: 1,
      }),
    ).rejects.toThrow(/after close/);
  });

  it("omits epoch when caller doesn't provide it (SDK falls through to registerWorker)", async () => {
    const fake = fakeHandle({ connected: true });
    const captured: Array<Record<string, unknown>> = [];
    fake.handle.reconnectTransport = vi.fn(async (opts) => {
      captured.push(opts as Record<string, unknown>);
    });
    const transport = await BridgeTransport.attach({
      tokens: tokenSource(),
      title: "t",
      cwd: "/w",
      deps: happyDeps(fake.handle),
    });
    await transport.reconnect({
      ingressToken: "x",
      apiBaseUrl: "https://api.anthropic.com",
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({
      ingressToken: "x",
      apiBaseUrl: "https://api.anthropic.com",
    });
    // epoch was NOT injected by the wrapper — explicit absence
    expect("epoch" in (captured[0] ?? {})).toBe(false);
  });
});
