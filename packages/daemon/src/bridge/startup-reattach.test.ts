import { describe, expect, it, vi } from "vitest";
import type {
  BridgeWorkerState,
  SidecodeSessionMetadata,
} from "../sidecode-sessions.js";
import type {
  BridgeAttachableRuntime,
  BridgeService,
} from "./bridge-service.js";
import type { TokenSource } from "./bridge-transport.js";
import type { CredentialsFailure, RemoteCredentials } from "./sdk-adapter.js";
import {
  reattachBridgedSessions,
  summarizeReattach,
} from "./startup-reattach.js";

const VALID_CREDS: RemoteCredentials = {
  worker_jwt: "jwt",
  worker_epoch: 1,
  api_base_url: "https://api.anthropic.com",
  expires_in: 14400,
} as unknown as RemoteCredentials;

function bridgeState(
  cseSessionId = "cse_abc",
  overrides: Partial<BridgeWorkerState> = {},
): BridgeWorkerState {
  return {
    cseSessionId,
    lastSSESequenceNum: 0,
    backfilled: false,
    ...overrides,
  };
}

function meta(
  cliSessionId: string,
  opts: {
    bridge?: BridgeWorkerState;
    isArchived?: boolean;
    cwd?: string;
    model?: string;
    title?: string;
  } = {},
): SidecodeSessionMetadata {
  const base: SidecodeSessionMetadata = {
    sessionId: `local_${cliSessionId}`,
    cliSessionId,
    cwd: opts.cwd ?? "/w",
    originCwd: opts.cwd ?? "/w",
    createdAt: 1,
    lastActivityAt: 1,
    isArchived: opts.isArchived ?? false,
    title: opts.title ?? `title-${cliSessionId}`,
    titleSource: "auto",
    permissionMode: "bypassPermissions",
    effort: "xhigh",
  };
  if (opts.model !== undefined) base.model = opts.model;
  if (opts.bridge !== undefined) base.bridge = opts.bridge;
  return base;
}

function fakeOauth(token = "tok"): TokenSource & { calls: number } {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    ensureFresh: async () => {
      calls++;
      return token;
    },
  };
}

function fakeRuntimeManager() {
  const created: string[] = [];
  return {
    created,
    getOrCreate(sessionId: string): BridgeAttachableRuntime {
      created.push(sessionId);
      return { bridge: null };
    },
  };
}

/** Build the minimum BridgeService surface the orchestrator touches:
 *  `attach(sessionId, runtime, request, existing)`. Tests pass concrete
 *  impls or vi.fn spies for each scenario. */
function fakeBridgeService(
  attachImpl: BridgeService["attach"] = (async () =>
    ({}) as never) as unknown as BridgeService["attach"],
): BridgeService & { attachSpy: ReturnType<typeof vi.fn> } {
  const attachSpy = vi.fn(attachImpl);
  return {
    attach: attachSpy as unknown as BridgeService["attach"],
    attachSpy,
  } as unknown as BridgeService & { attachSpy: ReturnType<typeof vi.fn> };
}

describe("reattachBridgedSessions — M3.4 startup re-attach + M3.6 SCOPE", () => {
  it("empty list → no-op, summary {0,0,0,0}", async () => {
    const summary = await reattachBridgedSessions({
      home: "/h",
      runtimeManager: fakeRuntimeManager(),
      bridgeService: fakeBridgeService(),
      oauth: fakeOauth(),
      log: () => {},
      listSidecodeSessions: () => [],
      clearBridgeWorkerState: () => undefined,
      fetchRemoteCredentials: vi.fn(),
    });
    expect(summary).toEqual({ total: 0, attached: 0, cleared: 0, failed: 0 });
  });

  it("sessions without `bridge` are SKIPPED (only bridged sessions enter the pipeline)", async () => {
    const probe = vi.fn();
    const summary = await reattachBridgedSessions({
      home: "/h",
      runtimeManager: fakeRuntimeManager(),
      bridgeService: fakeBridgeService(),
      oauth: fakeOauth(),
      log: () => {},
      listSidecodeSessions: () => [
        meta("s1"), // no bridge
        meta("s2"), // no bridge
      ],
      clearBridgeWorkerState: () => undefined,
      fetchRemoteCredentials: probe,
    });
    expect(summary.total).toBe(0);
    expect(probe).not.toHaveBeenCalled();
  });

  it("creds null → clears worker state + counts as cleared (session truly gone server-side)", async () => {
    const clearSpy = vi.fn(() => undefined);
    const probe = vi.fn(async () => null);
    const bridge = fakeBridgeService();
    const summary = await reattachBridgedSessions({
      home: "/h",
      runtimeManager: fakeRuntimeManager(),
      bridgeService: bridge,
      oauth: fakeOauth(),
      log: () => {},
      listSidecodeSessions: () => [meta("s1", { bridge: bridgeState() })],
      clearBridgeWorkerState: clearSpy,
      fetchRemoteCredentials: probe,
    });
    expect(summary).toEqual({ total: 1, attached: 0, cleared: 1, failed: 0 });
    expect(clearSpy).toHaveBeenCalledWith("/h", "s1");
    expect(bridge.attachSpy).not.toHaveBeenCalled();
  });

  it("CredentialsFailure → clears worker state + counts as cleared (terminal; user needs relogin)", async () => {
    const clearSpy = vi.fn(() => undefined);
    const failure: CredentialsFailure = {
      reason: "session_stale_relogin",
      terminal: true,
    } as unknown as CredentialsFailure;
    const probe = vi.fn(async () => failure);
    const bridge = fakeBridgeService();
    const summary = await reattachBridgedSessions({
      home: "/h",
      runtimeManager: fakeRuntimeManager(),
      bridgeService: bridge,
      oauth: fakeOauth(),
      log: () => {},
      listSidecodeSessions: () => [meta("s1", { bridge: bridgeState() })],
      clearBridgeWorkerState: clearSpy,
      fetchRemoteCredentials: probe,
    });
    expect(summary).toEqual({ total: 1, attached: 0, cleared: 1, failed: 0 });
    expect(clearSpy).toHaveBeenCalledWith("/h", "s1");
    expect(bridge.attachSpy).not.toHaveBeenCalled();
  });

  it("valid creds → materializes runtime + calls bridgeService.attach with existing", async () => {
    const rtMgr = fakeRuntimeManager();
    const bridge = fakeBridgeService();
    const probe = vi.fn(async () => VALID_CREDS);
    const summary = await reattachBridgedSessions({
      home: "/h",
      runtimeManager: rtMgr,
      bridgeService: bridge,
      oauth: fakeOauth(),
      log: () => {},
      listSidecodeSessions: () => [
        meta("s1", {
          bridge: bridgeState("cse_known", { lastSSESequenceNum: 42 }),
          cwd: "/proj",
          model: "claude-sonnet-4-6",
        }),
      ],
      clearBridgeWorkerState: () => undefined,
      fetchRemoteCredentials: probe,
    });

    expect(summary).toEqual({ total: 1, attached: 1, cleared: 0, failed: 0 });
    expect(rtMgr.created).toEqual(["s1"]);
    expect(bridge.attachSpy).toHaveBeenCalledOnce();
    const [sessionId, _runtime, request, existing] =
      bridge.attachSpy.mock.calls[0] ?? [];
    expect(sessionId).toBe("s1");
    expect(request).toMatchObject({
      title: "title-s1",
      cwd: "/proj",
      model: "claude-sonnet-4-6",
    });
    expect(existing).toEqual({
      cseSessionId: "cse_known",
      lastSSESequenceNum: 42,
    });
  });

  it("attach throws → counts as failed, leaves worker state intact (next-boot retry)", async () => {
    const clearSpy = vi.fn(() => undefined);
    const bridge = fakeBridgeService((async () => {
      throw new Error("transient_attach_fail");
    }) as unknown as BridgeService["attach"]);
    const summary = await reattachBridgedSessions({
      home: "/h",
      runtimeManager: fakeRuntimeManager(),
      bridgeService: bridge,
      oauth: fakeOauth(),
      log: () => {},
      listSidecodeSessions: () => [meta("s1", { bridge: bridgeState() })],
      clearBridgeWorkerState: clearSpy,
      fetchRemoteCredentials: vi.fn(async () => VALID_CREDS),
    });
    expect(summary).toEqual({ total: 1, attached: 0, cleared: 0, failed: 1 });
    expect(clearSpy).not.toHaveBeenCalled(); // disk preserved
  });

  it("OAuth ensureFresh throws → counts as failed, doesn't clear", async () => {
    const clearSpy = vi.fn(() => undefined);
    const bridge = fakeBridgeService();
    const probe = vi.fn();
    const summary = await reattachBridgedSessions({
      home: "/h",
      runtimeManager: fakeRuntimeManager(),
      bridgeService: bridge,
      oauth: {
        ensureFresh: async () => {
          throw new Error("keychain_locked");
        },
      },
      log: () => {},
      listSidecodeSessions: () => [meta("s1", { bridge: bridgeState() })],
      clearBridgeWorkerState: clearSpy,
      fetchRemoteCredentials: probe,
    });
    expect(summary).toEqual({ total: 1, attached: 0, cleared: 0, failed: 1 });
    expect(probe).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it("fetchRemoteCredentials throws (network) → counts as failed, doesn't clear", async () => {
    const clearSpy = vi.fn(() => undefined);
    const summary = await reattachBridgedSessions({
      home: "/h",
      runtimeManager: fakeRuntimeManager(),
      bridgeService: fakeBridgeService(),
      oauth: fakeOauth(),
      log: () => {},
      listSidecodeSessions: () => [meta("s1", { bridge: bridgeState() })],
      clearBridgeWorkerState: clearSpy,
      fetchRemoteCredentials: vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    expect(summary).toEqual({ total: 1, attached: 0, cleared: 0, failed: 1 });
    expect(clearSpy).not.toHaveBeenCalled();
  });

  it("M3.6 SCOPE — archived sessions WITH bridge are re-attached (claude.ai unarchive must keep the bridge live)", async () => {
    const bridge = fakeBridgeService();
    const summary = await reattachBridgedSessions({
      home: "/h",
      runtimeManager: fakeRuntimeManager(),
      bridgeService: bridge,
      oauth: fakeOauth(),
      log: () => {},
      listSidecodeSessions: () => [
        meta("active", { bridge: bridgeState("cse_a") }),
        meta("archived", {
          bridge: bridgeState("cse_b"),
          isArchived: true,
        }),
      ],
      clearBridgeWorkerState: () => undefined,
      fetchRemoteCredentials: vi.fn(async () => VALID_CREDS),
    });

    expect(summary).toEqual({ total: 2, attached: 2, cleared: 0, failed: 0 });
    expect(bridge.attachSpy).toHaveBeenCalledTimes(2);
    const cseIds = bridge.attachSpy.mock.calls
      .map((c) => (c[3] as { cseSessionId: string }).cseSessionId)
      .sort();
    expect(cseIds).toEqual(["cse_a", "cse_b"]);
  });

  it("mixed list — counts partition correctly across all 3 outcomes", async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(VALID_CREDS) // s_ok → attached
      .mockResolvedValueOnce(null) // s_dead → cleared
      .mockResolvedValueOnce({
        reason: "untrusted_device",
        terminal: true,
      } as CredentialsFailure) // s_stale → cleared
      .mockResolvedValueOnce(VALID_CREDS); // s_fail → fails at attach
    const bridge = fakeBridgeService((async (sessionId: string) => {
      if (sessionId === "s_fail") throw new Error("attach_5xx");
      return {} as never;
    }) as unknown as BridgeService["attach"]);
    const summary = await reattachBridgedSessions({
      home: "/h",
      runtimeManager: fakeRuntimeManager(),
      bridgeService: bridge,
      oauth: fakeOauth(),
      log: () => {},
      listSidecodeSessions: () => [
        meta("s_ok", { bridge: bridgeState("cse_ok") }),
        meta("s_dead", { bridge: bridgeState("cse_dead") }),
        meta("s_stale", { bridge: bridgeState("cse_stale") }),
        meta("s_fail", { bridge: bridgeState("cse_fail") }),
      ],
      clearBridgeWorkerState: () => undefined,
      fetchRemoteCredentials: probe,
    });
    expect(summary).toEqual({ total: 4, attached: 1, cleared: 2, failed: 1 });
  });

  it("threads baseUrl override into BOTH the creds probe AND the attach request (must agree)", async () => {
    const bridge = fakeBridgeService();
    const probe = vi.fn(async () => VALID_CREDS);
    await reattachBridgedSessions({
      home: "/h",
      runtimeManager: fakeRuntimeManager(),
      bridgeService: bridge,
      oauth: fakeOauth(),
      log: () => {},
      baseUrl: "https://staging.example.com",
      listSidecodeSessions: () => [meta("s1", { bridge: bridgeState() })],
      clearBridgeWorkerState: () => undefined,
      fetchRemoteCredentials: probe,
    });
    expect(probe).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://staging.example.com" }),
    );
    expect(bridge.attachSpy).toHaveBeenCalledWith(
      "s1",
      expect.anything(),
      expect.objectContaining({ baseUrl: "https://staging.example.com" }),
      expect.anything(),
    );
  });

  it("missing meta.model → request omits the `model` field entirely (don't write `undefined`)", async () => {
    const bridge = fakeBridgeService();
    await reattachBridgedSessions({
      home: "/h",
      runtimeManager: fakeRuntimeManager(),
      bridgeService: bridge,
      oauth: fakeOauth(),
      log: () => {},
      listSidecodeSessions: () => [meta("s1", { bridge: bridgeState() })],
      clearBridgeWorkerState: () => undefined,
      fetchRemoteCredentials: vi.fn(async () => VALID_CREDS),
    });
    const request = bridge.attachSpy.mock.calls[0]?.[2] as Record<
      string,
      unknown
    >;
    expect(request).not.toHaveProperty("model");
  });
});

describe("summarizeReattach", () => {
  it("formats the summary as a single-line bridge log", () => {
    expect(
      summarizeReattach({ total: 5, attached: 3, cleared: 1, failed: 1 }),
    ).toBe("[bridge] startup re-attach: 3/5 attached, 1 cleared, 1 failed");
  });
});
