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
    attachTransport: attachSpy as unknown as typeof import(
      "./bridge-transport.js"
    ).BridgeTransport.attach,
  });
  return { service, oauth, getOnClose: () => onClose, attachSpy };
}

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
      oauth,
      attachTransport: attachSpy as unknown as typeof import(
        "./bridge-transport.js"
      ).BridgeTransport.attach,
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
      oauth,
      attachTransport: attachSpy as unknown as typeof import(
        "./bridge-transport.js"
      ).BridgeTransport.attach,
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
      oauth,
      attachTransport: attachSpy as unknown as typeof import(
        "./bridge-transport.js"
      ).BridgeTransport.attach,
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
