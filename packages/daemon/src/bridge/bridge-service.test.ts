import { describe, expect, it, vi } from "vitest";
import {
  type BridgeAttachableRuntime,
  BridgeService,
  type OAuthManager,
} from "./bridge-service.js";
import type { BridgeTransport } from "./bridge-transport.js";

/** A fake OAuthManager recording start/stop + handing out a token. */
function fakeOAuth(): OAuthManager & {
  starts: number;
  stops: number;
} {
  let starts = 0;
  let stops = 0;
  return {
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
    ensureFresh: vi.fn(async () => "tok"),
    start: () => {
      starts++;
    },
    stop: () => {
      stops++;
    },
  };
}

/** A fake BridgeTransport (only the bits BridgeService touches). Captures the
 *  onClose passed into attach so tests can simulate a transport-initiated
 *  close. */
function fakeTransport(cseSessionId = "cse_x") {
  let closeCalls = 0;
  return {
    cseSessionId,
    get closeCalls() {
      return closeCalls;
    },
    close() {
      closeCalls++;
    },
    write() {},
    sendResult() {},
    getSequenceNum: () => 0,
    get isConnected() {
      return closeCalls === 0;
    },
  } as unknown as BridgeTransport & { closeCalls: number };
}

/** Build a service whose attachTransport returns the given transport (and
 *  records the onClose it was handed). */
function serviceWith(
  transport: BridgeTransport,
  oauth = fakeOAuth(),
): {
  service: BridgeService;
  oauth: ReturnType<typeof fakeOAuth>;
  getOnClose: () => ((code: number | undefined) => void) | undefined;
  attachSpy: ReturnType<typeof vi.fn>;
} {
  let onClose: ((code: number | undefined) => void) | undefined;
  const attachSpy = vi.fn(
    async (params: { onClose?: (code: number | undefined) => void }) => {
      onClose = params.onClose;
      return transport;
    },
  );
  const service = new BridgeService({
    oauth,
    home: "/test-home",
    persist: STUB_PERSIST,
    attachTransport:
      attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
  });
  return { service, oauth, getOnClose: () => onClose, attachSpy };
}

/** No-op persistence stubs — most tests don't care about the M3.1
 *  worker-state writes; the M3.1-specific tests below pass their own
 *  spies via the `persist` option. */
const STUB_PERSIST = {
  writeBridgeWorkerState: () => undefined,
  updateBridgeSequenceNum: () => undefined,
  clearBridgeWorkerState: () => undefined,
};

function runtime(): BridgeAttachableRuntime {
  return { bridge: null };
}

describe("BridgeService.attach", () => {
  it("opens a transport, wires runtime.bridge, and starts the OAuth timer", async () => {
    const t = fakeTransport("cse_1");
    const { service, oauth, attachSpy } = serviceWith(t);
    const rt = runtime();

    const returned = await service.attach("s1", rt, {
      title: "T",
      cwd: "/w",
      model: "claude-sonnet-4-6",
    });

    expect(returned).toBe(t);
    expect(rt.bridge).toBe(t); // wired so forwardToBridge mirrors
    expect(service.has("s1")).toBe(true);
    expect(service.size).toBe(1);
    expect(oauth.starts).toBe(1); // proactive timer armed
    // forwarded the request fields + injected the oauth as token source
    expect(attachSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: oauth,
        title: "T",
        cwd: "/w",
        model: "claude-sonnet-4-6",
      }),
    );
  });

  it("is a no-op on a second attach for the same session (no double-open)", async () => {
    const t = fakeTransport();
    const { service, attachSpy } = serviceWith(t);
    const rt = runtime();
    const first = await service.attach("s1", rt, { title: "T", cwd: "/w" });
    const second = await service.attach("s1", rt, { title: "T", cwd: "/w" });
    expect(second).toBe(first);
    expect(attachSpy).toHaveBeenCalledOnce(); // only one real attach
    expect(service.size).toBe(1);
  });

  it("on attach failure: leaves runtime.bridge untouched and stops the timer (no idle refresh loop)", async () => {
    const oauth = fakeOAuth();
    const attachSpy = vi.fn(async () => {
      throw new Error("create_failed");
    });
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth,
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    const rt = runtime();
    await expect(
      service.attach("s1", rt, { title: "T", cwd: "/w" }),
    ).rejects.toThrow("create_failed");
    expect(rt.bridge).toBeNull(); // no half-wired mirror
    expect(service.has("s1")).toBe(false);
    expect(oauth.starts).toBe(1);
    expect(oauth.stops).toBe(1); // started then stopped — net zero idle loop
  });

  it("throws after shutdown", async () => {
    const { service } = serviceWith(fakeTransport());
    service.shutdown();
    await expect(
      service.attach("s1", runtime(), { title: "T", cwd: "/w" }),
    ).rejects.toThrow(/shut down/);
  });
});

describe("BridgeService — inbound prompt routing (M2.2)", () => {
  it("wires inbound when onInboundPrompt is set, and routes extracted prompts to it", async () => {
    const t = fakeTransport();
    const routed: Array<{ sessionId: string; text: string; uuid?: string }> =
      [];
    let capturedInbound:
      | { onInboundMessage?: (msg: unknown) => void }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: { onInboundMessage?: (msg: unknown) => void };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      onInboundPrompt: (sessionId, prompt) =>
        routed.push({ sessionId, text: prompt.text, uuid: prompt.uuid }),
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });

    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    // inbound bag was passed → transport opens bidirectional.
    expect(capturedInbound).toBeDefined();
    expect(typeof capturedInbound?.onInboundMessage).toBe("function");

    // A real claude.ai user message → extracted + routed with the session id.
    capturedInbound?.onInboundMessage?.({
      type: "user",
      uuid: "claude-uuid-1",
      message: { role: "user", content: "hello from cloud" },
    });
    expect(routed).toEqual([
      { sessionId: "s1", text: "hello from cloud", uuid: "claude-uuid-1" },
    ]);
  });

  it("drops non-prompt inbound frames (does not call the router)", async () => {
    const t = fakeTransport();
    const routed: unknown[] = [];
    let capturedInbound:
      | { onInboundMessage?: (msg: unknown) => void }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: { onInboundMessage?: (msg: unknown) => void };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      onInboundPrompt: (sessionId, prompt) =>
        routed.push({ sessionId, prompt }),
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    // assistant frame + empty user → both filtered by extractInboundPrompt.
    capturedInbound?.onInboundMessage?.({
      type: "assistant",
      message: { content: "x" },
    });
    capturedInbound?.onInboundMessage?.({
      type: "user",
      message: { content: [] },
    });
    expect(routed).toEqual([]);
  });

  it("does NOT wire inbound when ALL handlers are omitted (mirror mode — M1 regression guard)", async () => {
    const t = fakeTransport();
    let captured: { inbound?: unknown } | undefined;
    const attachSpy = vi.fn(async (params: { inbound?: unknown }) => {
      captured = params;
      return t;
    });
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      // No onInboundPrompt, no onInterrupt, no onSetModel.
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    // inbound undefined → transport derives outboundOnly:true (pure mirror,
    // M1 behavior preserved when no caller wires the control surface).
    expect(captured?.inbound).toBeUndefined();
  });
});

describe("BridgeService — control routing (M2.4)", () => {
  it("wires onInterrupt into the inbound bag and routes with the session id", async () => {
    const t = fakeTransport();
    const interrupts: string[] = [];
    let capturedInbound:
      | { onInterrupt?: () => void; onInboundMessage?: unknown }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: { onInterrupt?: () => void; onInboundMessage?: unknown };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      // ONLY onInterrupt — no prompt routing, no setModel.
      onInterrupt: (sessionId) => interrupts.push(sessionId),
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    // inbound bag built, contains ONLY onInterrupt (partial wiring is fine).
    expect(capturedInbound).toBeDefined();
    expect(typeof capturedInbound?.onInterrupt).toBe("function");
    expect(capturedInbound?.onInboundMessage).toBeUndefined();

    // SDK fires the handler → routed with the session id.
    capturedInbound?.onInterrupt?.();
    expect(interrupts).toEqual(["s1"]);
  });

  it("wires onSetModel into the inbound bag and routes (session id + model)", async () => {
    const t = fakeTransport();
    const models: Array<{ sessionId: string; model: string | undefined }> = [];
    let capturedInbound:
      | { onSetModel?: (model: string | undefined) => void }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: { onSetModel?: (model: string | undefined) => void };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      onSetModel: (sessionId, model) => models.push({ sessionId, model }),
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    expect(typeof capturedInbound?.onSetModel).toBe("function");
    capturedInbound?.onSetModel?.("claude-opus-4-8");
    capturedInbound?.onSetModel?.(undefined); // reset-to-default
    expect(models).toEqual([
      { sessionId: "s1", model: "claude-opus-4-8" },
      { sessionId: "s1", model: undefined },
    ]);
  });

  it("composes all three handlers when all are provided", async () => {
    // Production wiring (index.ts) provides all three together — verify the
    // bag carries each, and each routes to its respective callback.
    const t = fakeTransport();
    const seen: string[] = [];
    let capturedInbound:
      | {
          onInboundMessage?: (msg: unknown) => void;
          onInterrupt?: () => void;
          onSetModel?: (model: string | undefined) => void;
        }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: {
          onInboundMessage?: (msg: unknown) => void;
          onInterrupt?: () => void;
          onSetModel?: (model: string | undefined) => void;
        };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      onInboundPrompt: (sid, p) => seen.push(`prompt:${sid}:${p.text}`),
      onInterrupt: (sid) => seen.push(`interrupt:${sid}`),
      onSetModel: (sid, m) => seen.push(`setModel:${sid}:${m ?? "null"}`),
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    expect(typeof capturedInbound?.onInboundMessage).toBe("function");
    expect(typeof capturedInbound?.onInterrupt).toBe("function");
    expect(typeof capturedInbound?.onSetModel).toBe("function");

    capturedInbound?.onInboundMessage?.({
      type: "user",
      uuid: "u-1",
      message: { role: "user", content: "hi" },
    });
    capturedInbound?.onInterrupt?.();
    capturedInbound?.onSetModel?.("claude-sonnet-4-6");
    expect(seen).toEqual([
      "prompt:s1:hi",
      "interrupt:s1",
      "setModel:s1:claude-sonnet-4-6",
    ]);
  });

  it("auto-attaches onSetPermissionMode stub returning V0 refuse verdict whenever bidirectional", async () => {
    // V0 fixes bypassPermissions (project_no_plan_mode_v0). The stub beats the
    // SDK's generic "callback not registered" auto-error by giving claude.ai
    // a sidecode-specific reason. Static — no router, no per-session state.
    const t = fakeTransport();
    let capturedInbound:
      | {
          onSetPermissionMode?: (
            mode: unknown,
          ) => { ok: true } | { ok: false; error: string };
        }
      | undefined;
    const attachSpy = vi.fn(
      async (params: {
        inbound?: {
          onSetPermissionMode?: (
            mode: unknown,
          ) => { ok: true } | { ok: false; error: string };
        };
      }) => {
        capturedInbound = params.inbound;
        return t;
      },
    );
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      // Any one caller handler suffices to flip bidirectional — that's when
      // the stub is attached. Using onInterrupt here, but the stub is
      // independent of WHICH caller handler triggered bidirectional mode.
      onInterrupt: () => {},
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });

    expect(typeof capturedInbound?.onSetPermissionMode).toBe("function");
    const verdict = capturedInbound?.onSetPermissionMode?.("plan");
    expect(verdict?.ok).toBe(false);
    // Refuse for ANY mode (acceptEdits / default / plan / bypassPermissions
    // all refused — V0 locks bypass; only revisit when plan / approval UI lands).
    expect(capturedInbound?.onSetPermissionMode?.("default")?.ok).toBe(false);
    expect(capturedInbound?.onSetPermissionMode?.("acceptEdits")?.ok).toBe(
      false,
    );
    if (verdict?.ok === false) {
      // ASCII-only error per repo convention; mention bypassPermissions so the
      // user understands WHY without reading sidecode source.
      expect(verdict.error).toMatch(/bypassPermissions/);
      expect(verdict.error).not.toMatch(/[一-鿿]/); // no CJK
    }
  });

  it("does NOT auto-attach onSetPermissionMode in pure mirror mode (no caller handlers)", async () => {
    // The stub is bundled into the bag, not bolted on independently — so when
    // hasInbound is false (M1 pure mirror) the bag is undefined and the SDK
    // sees no onSetPermissionMode at all. Pure mirror has no read channel
    // anyway, so claude.ai can't reach the worker with set_permission_mode.
    const t = fakeTransport();
    let captured: { inbound?: unknown } | undefined;
    const attachSpy = vi.fn(async (params: { inbound?: unknown }) => {
      captured = params;
      return t;
    });
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth: fakeOAuth(),
      // No caller handlers → hasInbound false → no bag.
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    expect(captured?.inbound).toBeUndefined();
  });
});

describe("BridgeService.detach", () => {
  it("closes the transport, clears runtime.bridge, stops the timer on last bridge", async () => {
    const t = fakeTransport();
    const { service, oauth } = serviceWith(t);
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });

    service.detach("s1", rt);

    expect((t as unknown as { closeCalls: number }).closeCalls).toBe(1);
    expect(rt.bridge).toBeNull();
    expect(service.has("s1")).toBe(false);
    expect(oauth.stops).toBe(1); // last bridge gone → timer stopped
  });

  it("is a no-op for an unknown session", async () => {
    const { service } = serviceWith(fakeTransport());
    expect(() => service.detach("nope", runtime())).not.toThrow();
  });

  it("keeps the OAuth timer running while other bridges remain", async () => {
    // Two sessions, two transports. Detaching one must NOT stop the timer.
    const oauth = fakeOAuth();
    const t1 = fakeTransport("cse_1");
    const t2 = fakeTransport("cse_2");
    const queue = [t1, t2];
    const attachSpy = vi.fn(async () => queue.shift());
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth,
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    const rt1 = runtime();
    const rt2 = runtime();
    await service.attach("s1", rt1, { title: "T", cwd: "/w" });
    await service.attach("s2", rt2, { title: "T", cwd: "/w" });
    expect(service.size).toBe(2);

    service.detach("s1", rt1);
    expect(service.size).toBe(1);
    expect(oauth.stops).toBe(0); // s2 still bridged → timer stays up

    service.detach("s2", rt2);
    expect(oauth.stops).toBe(1); // now empty → stop
  });
});

describe("BridgeService — transport-initiated close (onClose)", () => {
  it("forgets the session + clears runtime.bridge when the transport closes itself", async () => {
    const t = fakeTransport();
    const { service, oauth, getOnClose } = serviceWith(t);
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });

    // Simulate a 401 jwt-expired close from the transport side.
    getOnClose()?.(401);

    expect(service.has("s1")).toBe(false);
    expect(rt.bridge).toBeNull();
    expect(oauth.stops).toBe(1);
  });
});

describe("BridgeService.shutdown", () => {
  it("closes all transports and stops the OAuth manager; idempotent", async () => {
    const oauth = fakeOAuth();
    const t1 = fakeTransport("cse_1");
    const t2 = fakeTransport("cse_2");
    const queue = [t1, t2];
    const attachSpy = vi.fn(async () => queue.shift());
    const service = new BridgeService({
      home: "/test-home",
      persist: STUB_PERSIST,
      oauth,
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    await service.attach("s2", runtime(), { title: "T", cwd: "/w" });

    service.shutdown();
    service.shutdown(); // idempotent

    expect((t1 as unknown as { closeCalls: number }).closeCalls).toBe(1);
    expect((t2 as unknown as { closeCalls: number }).closeCalls).toBe(1);
    expect(service.size).toBe(0);
    // stop() called: once when map emptied during shutdown loop is NOT how it
    // works (shutdown clears then stops once) — assert at least the final stop.
    expect(oauth.stops).toBeGreaterThanOrEqual(1);
  });
});

describe("BridgeService — M3.1 worker-state persistence", () => {
  it("attach writes initial bridge worker state {cseSessionId, lastSSESequenceNum:0, backfilled:false}", async () => {
    const t = fakeTransport("cse_42");
    const persist = {
      writeBridgeWorkerState: vi.fn(() => undefined),
      updateBridgeSequenceNum: vi.fn(() => undefined),
      clearBridgeWorkerState: vi.fn(() => undefined),
    };
    const service = new BridgeService({
      home: "/test-home",
      oauth: fakeOAuth(),
      persist,
      attachTransport: vi.fn(
        async () => t,
      ) as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await service.attach("local-sess-1", runtime(), { title: "T", cwd: "/w" });
    expect(persist.writeBridgeWorkerState).toHaveBeenCalledWith(
      "/test-home",
      "local-sess-1",
      { cseSessionId: "cse_42", lastSSESequenceNum: 0, backfilled: false },
    );
  });

  it("attach passes a persistSequenceNum closure that routes through updateBridgeSequenceNum", async () => {
    const t = fakeTransport();
    let captured: { persistSequenceNum?: (seq: number) => void } | undefined;
    const attachSpy = vi.fn(async (params: typeof captured) => {
      captured = params;
      return t;
    });
    const persist = {
      writeBridgeWorkerState: vi.fn(() => undefined),
      updateBridgeSequenceNum: vi.fn(() => undefined),
      clearBridgeWorkerState: vi.fn(() => undefined),
    };
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist,
      attachTransport:
        attachSpy as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await service.attach("sess-A", runtime(), { title: "T", cwd: "/w" });
    expect(typeof captured?.persistSequenceNum).toBe("function");
    // Invoke as if BridgeTransport.checkpoint did → updateBridgeSequenceNum
    // gets the right (home, cliSessionId, seq) triple. This is the routing
    // proof: home + sessionId are closed over correctly per-attach.
    captured?.persistSequenceNum?.(7);
    expect(persist.updateBridgeSequenceNum).toHaveBeenCalledWith(
      "/h",
      "sess-A",
      7,
    );
  });

  it("detach clears the bridge worker state (explicit unbridge intent)", async () => {
    const t = fakeTransport();
    const persist = {
      writeBridgeWorkerState: vi.fn(() => undefined),
      updateBridgeSequenceNum: vi.fn(() => undefined),
      clearBridgeWorkerState: vi.fn(() => undefined),
    };
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist,
      attachTransport: vi.fn(
        async () => t,
      ) as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    const rt = runtime();
    await service.attach("s1", rt, { title: "T", cwd: "/w" });
    service.detach("s1", rt);
    expect(persist.clearBridgeWorkerState).toHaveBeenCalledWith("/h", "s1");
  });

  it("transport-initiated onClose (4090 epoch / 401 jwt) does NOT clear worker state — M3.4 reattach needs it", async () => {
    // onClose goes through forget(), not detach(), so worker state must
    // persist for restart re-attach to find this bridged session.
    const t = fakeTransport();
    let onClose: ((code: number | undefined) => void) | undefined;
    const persist = {
      writeBridgeWorkerState: vi.fn(() => undefined),
      updateBridgeSequenceNum: vi.fn(() => undefined),
      clearBridgeWorkerState: vi.fn(() => undefined),
    };
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      persist,
      attachTransport: vi.fn(
        async (params: { onClose?: (code: number | undefined) => void }) => {
          onClose = params.onClose;
          return t;
        },
      ) as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await service.attach("s1", runtime(), { title: "T", cwd: "/w" });
    onClose?.(4090);
    expect(persist.clearBridgeWorkerState).not.toHaveBeenCalled();
  });

  it("attach logs (but does not throw) when metadata is missing — writeBridgeWorkerState returns undefined", async () => {
    const t = fakeTransport();
    const messages: string[] = [];
    const persist = {
      writeBridgeWorkerState: vi.fn(() => undefined), // simulate missing metadata
      updateBridgeSequenceNum: vi.fn(() => undefined),
      clearBridgeWorkerState: vi.fn(() => undefined),
    };
    const service = new BridgeService({
      home: "/h",
      oauth: fakeOAuth(),
      log: (m) => messages.push(m),
      persist,
      attachTransport: vi.fn(
        async () => t,
      ) as unknown as typeof import("./bridge-transport.js").BridgeTransport.attach,
    });
    await expect(
      service.attach("s1", runtime(), { title: "T", cwd: "/w" }),
    ).resolves.toBe(t);
    expect(
      messages.some((m) =>
        m.includes("no sidecode metadata to persist worker state"),
      ),
    ).toBe(true);
  });
});
