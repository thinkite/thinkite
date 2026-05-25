import { describe, expect, it } from "vitest";
import {
  approveCommand,
  clientFrame,
  command,
  continueOnDesktopCommand,
  continueOnDesktopResponse,
  daemonFrame,
  decodePairOfferPayload,
  deleteSessionCommand,
  deleteSessionResponse,
  encodePairOffer,
  errorFrame,
  event,
  eventDelta,
  eventFrame,
  getMessagesCommand,
  getMessagesResponse,
  getModelsCommand,
  getModelsResponse,
  helloCommand,
  interruptCommand,
  interruptResponse,
  isProtocolCompatible,
  listSessionsCommand,
  listSessionsResponse,
  PAIR_OFFER_VERSION,
  PROTOCOL_VERSION,
  pairOfferFrame,
  pingFrame,
  pongFrame,
  sendPromptCommand,
  sendPromptResponse,
  serverInfoEvent,
  sessionDivergedEvent,
  sessionInfo,
  subscribeCommand,
  subscribeResponse,
  unsubscribeCommand,
  unsubscribeResponse,
} from "./index.js";

describe("PROTOCOL_VERSION", () => {
  it("is a valid semver string sourced from package.json", () => {
    // PROTOCOL_VERSION is read directly from packages/protocol/package.json
    // at module load — no hand-maintained duplicate constant, no drift
    // possible. Just sanity-check it parses as semver.
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("isProtocolCompatible", () => {
  it("accepts the local version verbatim", () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION)).toBe(true);
  });

  it("npm caret semantics for 0.0.x: exact-match only (every change is breaking)", () => {
    // npm convention: ^0.0.0 → >=0.0.0 <0.0.1. No upgrades allowed
    // because at 0.0.x every change is potentially breaking. We surface
    // this through `^PROTOCOL_VERSION`. If PROTOCOL_VERSION is in this
    // range, anything other than exact-match is rejected.
    if (PROTOCOL_VERSION.startsWith("0.0.")) {
      const [, , patch] = PROTOCOL_VERSION.split(".").map(Number);
      expect(isProtocolCompatible(`0.0.${patch + 1}`)).toBe(false);
      expect(isProtocolCompatible(`0.1.0`)).toBe(false);
      expect(isProtocolCompatible(`1.0.0`)).toBe(false);
    }
  });

  it("npm caret semantics for 0.x.y (x≥1): same minor + patch ≥ local", () => {
    // ^0.5.3 → >=0.5.3 <0.6.0. Patch upgrades OK, minor bump breaking.
    if (
      PROTOCOL_VERSION.startsWith("0.") &&
      !PROTOCOL_VERSION.startsWith("0.0.")
    ) {
      const [, minor, patch] = PROTOCOL_VERSION.split(".").map(Number);
      expect(isProtocolCompatible(`0.${minor}.${patch + 5}`)).toBe(true);
      expect(isProtocolCompatible(`0.${minor + 1}.0`)).toBe(false);
    }
  });

  it("pre-release versions don't satisfy a stable caret range", () => {
    // npm convention: 1.0.0-beta.1 does NOT satisfy ^1.0.0. We surface
    // semver's default behavior here (`includePrerelease: false`) so a
    // dev build pointed at a stable client doesn't get silently
    // approved. If the user wants to test prereleases together, both
    // ends will be on the same prerelease tag and exact-match.
    expect(isProtocolCompatible(`${PROTOCOL_VERSION}-beta.1`)).toBe(false);
  });

  it("rejects garbage / non-semver input (defensive)", () => {
    expect(isProtocolCompatible("not-a-version")).toBe(false);
    expect(isProtocolCompatible("")).toBe(false);
    expect(isProtocolCompatible("1")).toBe(false);
  });
});

describe("pair offer", () => {
  it("PAIR_OFFER_VERSION is 2", () => {
    // Bumping forces an old iOS app to fail-decode an incompatible QR
    // with a clear "update sidecode on your Mac" error, rather than
    // silently mis-parsing.
    expect(PAIR_OFFER_VERSION).toBe(2);
  });

  const valid = {
    type: "pair.offer" as const,
    v: PAIR_OFFER_VERSION,
    daemonIdentityPublicKey: "AAAA",
    serviceName: "sidecode-mac",
  };

  it("parses a minimal offer (pubkey + serviceName only)", () => {
    const parsed = pairOfferFrame.parse(valid);
    expect(parsed.daemonIdentityPublicKey).toBe("AAAA");
    expect(parsed.serviceName).toBe("sidecode-mac");
    expect(parsed.v).toBe(PAIR_OFFER_VERSION);
  });

  it("rejects when daemonIdentityPublicKey is missing", () => {
    const { daemonIdentityPublicKey: _, ...rest } = valid;
    expect(pairOfferFrame.safeParse(rest).success).toBe(false);
  });

  it("rejects when serviceName is missing", () => {
    const { serviceName: _, ...rest } = valid;
    expect(pairOfferFrame.safeParse(rest).success).toBe(false);
  });

  it("encodePairOffer round-trips through decodePairOfferPayload", () => {
    const encoded = encodePairOffer(valid);
    // base64url alphabet, no padding.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = decodePairOfferPayload(encoded);
    expect(decoded).toEqual(valid);
  });

  it("wire payload is small enough for QR ecLevel M without bumping versions", () => {
    // Sanity: a realistic pubkey (43 base64url chars for 32 raw bytes)
    // + typical hostname should encode in well under 140 chars total,
    // keeping the rendered QR scannable from arm's length.
    const realistic = {
      type: "pair.offer" as const,
      v: PAIR_OFFER_VERSION,
      daemonIdentityPublicKey: "vqRrAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", // 43 chars
      serviceName: "yueqians-macbook-pro.local",
    };
    const encoded = encodePairOffer(realistic);
    expect(encoded.length).toBeLessThan(140);
  });
});

describe("event union", () => {
  it("accepts session.updated", () => {
    expect(
      event.parse({ type: "session.updated", sessionId: "x", lastModified: 1 })
        .type,
    ).toBe("session.updated");
  });

  it("rejects unknown event type", () => {
    expect(event.safeParse({ type: "session.bogus" }).success).toBe(false);
  });

  it("session.diverged requires ≥2 branches", () => {
    expect(
      sessionDivergedEvent.safeParse({
        type: "session.diverged",
        sessionId: "a",
        branches: ["only-one"],
      }).success,
    ).toBe(false);
  });
});

describe("command union", () => {
  it("accepts a minimal sendPrompt (resume — no cwd)", () => {
    expect(
      sendPromptCommand.parse({
        type: "sendPrompt",
        requestId: "r1",
        sessionId: "x",
        text: "hi",
      }).text,
    ).toBe("hi");
  });

  it("accepts a sendPrompt with cwd (new-session create path)", () => {
    expect(
      sendPromptCommand.parse({
        type: "sendPrompt",
        requestId: "r2",
        sessionId: "x",
        text: "hi",
        cwd: "/repo",
      }).cwd,
    ).toBe("/repo");
  });

  it("rejects sendPrompt missing requestId", () => {
    expect(
      sendPromptCommand.safeParse({
        type: "sendPrompt",
        sessionId: "x",
        text: "hi",
      }).success,
    ).toBe(false);
  });

  it("accepts a sendPrompt with model + effort (picker selection)", () => {
    const r = sendPromptCommand.parse({
      type: "sendPrompt",
      requestId: "r3",
      sessionId: "x",
      text: "hi",
      model: "claude-opus-4-7[1m]",
      effort: "high",
    });
    expect(r.model).toBe("claude-opus-4-7[1m]");
    expect(r.effort).toBe("high");
  });

  it("accepts sendPrompt with model but no effort (Haiku-tier)", () => {
    const r = sendPromptCommand.parse({
      type: "sendPrompt",
      requestId: "r4",
      sessionId: "x",
      text: "hi",
      model: "claude-haiku-4-5-20251001",
    });
    expect(r.model).toBe("claude-haiku-4-5-20251001");
    expect(r.effort).toBeUndefined();
  });

  it("rejects sendPrompt with an invalid effort value", () => {
    expect(
      sendPromptCommand.safeParse({
        type: "sendPrompt",
        requestId: "r5",
        sessionId: "x",
        text: "hi",
        effort: "ultra",
      }).success,
    ).toBe(false);
  });

  it("rejects approve with bad decision", () => {
    expect(
      approveCommand.safeParse({
        type: "approve",
        requestId: "x",
        decision: "maybe",
      }).success,
    ).toBe(false);
  });

  it("includes listSessions and deleteSession", () => {
    expect(command.parse({ type: "listSessions", requestId: "r1" }).type).toBe(
      "listSessions",
    );
    expect(
      command.parse({ type: "deleteSession", requestId: "r2", sessionId: "s" })
        .type,
    ).toBe("deleteSession");
  });

  it("includes streaming-session commands", () => {
    expect(
      command.parse({ type: "subscribe", requestId: "r1", sessionId: "s" })
        .type,
    ).toBe("subscribe");
    expect(
      command.parse({ type: "unsubscribe", requestId: "r2", sessionId: "s" })
        .type,
    ).toBe("unsubscribe");
    expect(
      command.parse({ type: "interrupt", requestId: "r3", sessionId: "s" })
        .type,
    ).toBe("interrupt");
  });
});

describe("eventDelta union", () => {
  it("parses turn lifecycle variants", () => {
    expect(eventDelta.parse({ kind: "turn_started" }).kind).toBe(
      "turn_started",
    );
    expect(eventDelta.parse({ kind: "turn_canceled" }).kind).toBe(
      "turn_canceled",
    );
    expect(eventDelta.parse({ kind: "turn_failed", error: "boom" }).kind).toBe(
      "turn_failed",
    );
    expect(eventDelta.parse({ kind: "turn_completed" }).kind).toBe(
      "turn_completed",
    );
  });

  it("turn_completed accepts optional usage stats", () => {
    const p = eventDelta.parse({
      kind: "turn_completed",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    if (p.kind !== "turn_completed") throw new Error("unexpected kind");
    expect(p.usage?.inputTokens).toBe(100);
  });

  it("rejects unknown kind", () => {
    expect(eventDelta.safeParse({ kind: "garbage" }).success).toBe(false);
  });
});

describe("streaming-session response + event frames", () => {
  it("subscribe.response carries settled + cursor", () => {
    const p = subscribeResponse.parse({
      type: "subscribe.response",
      requestId: "r1",
      sessionId: "s",
      settled: [],
      cursor: 0,
    });
    expect(p.cursor).toBe(0);
  });

  it("unsubscribe / sendPrompt / interrupt responses are minimal", () => {
    expect(
      unsubscribeResponse.parse({
        type: "unsubscribe.response",
        requestId: "r1",
      }).requestId,
    ).toBe("r1");
    expect(
      sendPromptResponse.parse({
        type: "sendPrompt.response",
        requestId: "r2",
      }).requestId,
    ).toBe("r2");
    expect(
      interruptResponse.parse({
        type: "interrupt.response",
        requestId: "r3",
      }).requestId,
    ).toBe("r3");
  });

  it("event frame wraps an EventDelta with sessionId + cursor", () => {
    const p = eventFrame.parse({
      type: "event",
      sessionId: "s",
      cursor: 5,
      delta: { kind: "turn_started" },
    });
    expect(p.delta.kind).toBe("turn_started");
  });

  it("subscribe / unsubscribe / interrupt commands require requestId", () => {
    expect(
      subscribeCommand.safeParse({ type: "subscribe", sessionId: "s" }).success,
    ).toBe(false);
    expect(
      unsubscribeCommand.safeParse({ type: "unsubscribe", sessionId: "s" })
        .success,
    ).toBe(false);
    expect(
      interruptCommand.safeParse({ type: "interrupt", sessionId: "s" }).success,
    ).toBe(false);
  });
});

describe("session metadata", () => {
  it("parses minimal SessionInfo (required fields only)", () => {
    const p = sessionInfo.parse({
      sessionId: "s1",
      cwd: "/Users/x",
      originCwd: "/Users/x",
      lastActivityAt: 1,
      origin: "desktop-mirror",
      cliSessionId: "cli-1",
    });
    expect(p.sessionId).toBe("s1");
    expect(p.title).toBeUndefined();
  });

  it("rejects SessionInfo missing cliSessionId", () => {
    expect(
      sessionInfo.safeParse({
        sessionId: "s1",
        cwd: "/Users/x",
        originCwd: "/Users/x",
        lastActivityAt: 1,
        origin: "desktop-mirror",
      }).success,
    ).toBe(false);
  });

  it("rejects SessionInfo missing originCwd", () => {
    expect(
      sessionInfo.safeParse({
        sessionId: "s1",
        cwd: "/Users/x",
        lastActivityAt: 1,
        origin: "desktop-mirror",
        cliSessionId: "cli-1",
      }).success,
    ).toBe(false);
  });

  it("parses fully-populated SessionInfo with fork (cwd != originCwd)", () => {
    const p = sessionInfo.parse({
      sessionId: "local_119c4694-f67a-4e16-b99c-140567c682fd",
      cwd: "/Users/x/proj/worktrees/feature",
      originCwd: "/Users/x/proj",
      lastActivityAt: 1777000000000,
      origin: "desktop-mirror",
      cliSessionId: "03f3f808-9702-4dda-82da-34a8b3f76879",
      title: "Plan project folder structure (fork)",
      model: "claude-opus-4-7[1m]",
      modelLabel: "Opus 4.7 1M",
      effort: "xhigh",
      isArchived: false,
    });
    expect(p.cwd).not.toBe(p.originCwd);
    expect(p.modelLabel).toBe("Opus 4.7 1M");
    expect(p.effort).toBe("xhigh");
    expect(p.isArchived).toBe(false);
  });

  it("rejects unknown origin", () => {
    expect(
      sessionInfo.safeParse({
        sessionId: "s1",
        cwd: "/x",
        lastActivityAt: 1,
        origin: "made-up",
      }).success,
    ).toBe(false);
  });
});

describe("request/response correlation", () => {
  it("listSessions roundtrip preserves requestId", () => {
    const req = listSessionsCommand.parse({
      type: "listSessions",
      requestId: "r",
      dir: "/tmp",
    });
    const res = listSessionsResponse.parse({
      type: "listSessions.response",
      requestId: "r",
      sessions: [
        {
          sessionId: "s1",
          cwd: "/tmp",
          originCwd: "/tmp",
          lastActivityAt: 1,
          origin: "desktop-mirror",
          cliSessionId: "cli-s1",
        },
      ],
    });
    expect(req.requestId).toBe(res.requestId);
  });

  it("deleteSession roundtrip", () => {
    expect(
      deleteSessionCommand.parse({
        type: "deleteSession",
        requestId: "r",
        sessionId: "s",
      }).requestId,
    ).toBe(
      deleteSessionResponse.parse({
        type: "deleteSession.response",
        requestId: "r",
      }).requestId,
    );
  });

  it("continueOnDesktop minimal command + ok response", () => {
    const req = continueOnDesktopCommand.parse({
      type: "continueOnDesktop",
      requestId: "r1",
      cliSessionId: "0a264f0b-d5dc-41a0-b6a9-a2ccc978ab50",
    });
    expect(req.cliSessionId).toBe("0a264f0b-d5dc-41a0-b6a9-a2ccc978ab50");
    expect(req.desktopLocalSessionId).toBeUndefined();

    const ok = continueOnDesktopResponse.parse({
      type: "continueOnDesktop.response",
      requestId: "r1",
      ok: true,
    });
    expect(ok.ok).toBe(true);
    expect(ok.error).toBeUndefined();
  });

  it("continueOnDesktop accepts optional desktopLocalSessionId", () => {
    const req = continueOnDesktopCommand.parse({
      type: "continueOnDesktop",
      requestId: "r2",
      cliSessionId: "abc",
      desktopLocalSessionId: "local_119c4694-f67a-4e16-b99c-140567c682fd",
    });
    expect(req.desktopLocalSessionId).toBe(
      "local_119c4694-f67a-4e16-b99c-140567c682fd",
    );
  });

  it("continueOnDesktop response carries error string when ok=false", () => {
    const res = continueOnDesktopResponse.parse({
      type: "continueOnDesktop.response",
      requestId: "r3",
      ok: false,
      error: "open exited 1",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("open exited 1");
  });

  it("continueOnDesktop is included in command + clientFrame + daemonFrame unions", () => {
    expect(
      command.parse({
        type: "continueOnDesktop",
        requestId: "r",
        cliSessionId: "abc",
      }).type,
    ).toBe("continueOnDesktop");
    expect(
      clientFrame.parse({
        type: "continueOnDesktop",
        requestId: "r",
        cliSessionId: "abc",
      }).type,
    ).toBe("continueOnDesktop");
    expect(
      daemonFrame.parse({
        type: "continueOnDesktop.response",
        requestId: "r",
        ok: true,
      }).type,
    ).toBe("continueOnDesktop.response");
  });

  it("getMessages command requires cliSessionId; cwd is an optional hint", () => {
    // cwd-less is the canonical V0 shape — fork sessions' JSONL location
    // isn't deterministic, so iOS omits the hint and lets the SDK scan all
    // projects.
    const minimal = getMessagesCommand.parse({
      type: "getMessages",
      requestId: "g1",
      cliSessionId: "cli-abc",
    });
    expect(minimal.cliSessionId).toBe("cli-abc");
    expect(minimal.cwd).toBeUndefined();

    // cwd is still allowed (forward-compat for a future "try cwd hint
    // first" perf optimization).
    const withHint = getMessagesCommand.parse({
      type: "getMessages",
      requestId: "g1",
      cliSessionId: "cli-abc",
      cwd: "/Users/x/proj",
    });
    expect(withHint.cwd).toBe("/Users/x/proj");
  });

  it("getMessages response carries normalized TimelineItem[]", () => {
    const res = getMessagesResponse.parse({
      type: "getMessages.response",
      requestId: "g1",
      items: [
        { type: "user_message", uuid: "m-1", text: "hi" },
        { type: "assistant_message", uuid: "m-2", text: "hello" },
        {
          type: "tool_call",
          callId: "tu-1",
          name: "Bash",
          summary: "List files in current directory",
          status: "completed",
          error: null,
          detail: {
            type: "bash",
            command: "ls",
            description: "List files in current directory",
            output: "file.txt\n",
          },
        },
      ],
    });
    expect(res.items).toHaveLength(3);
    expect(res.items[0]?.type).toBe("user_message");
    const tool = res.items[2];
    if (tool?.type !== "tool_call")
      throw new Error("expected tool_call as last item");
    expect(tool.detail.type).toBe("bash");
  });

  it("getMessages is included in command + clientFrame + daemonFrame unions", () => {
    expect(
      command.parse({
        type: "getMessages",
        requestId: "g",
        cliSessionId: "x",
      }).type,
    ).toBe("getMessages");
    expect(
      clientFrame.parse({
        type: "getMessages",
        requestId: "g",
        cliSessionId: "x",
      }).type,
    ).toBe("getMessages");
    expect(
      daemonFrame.parse({
        type: "getMessages.response",
        requestId: "g",
        items: [],
      }).type,
    ).toBe("getMessages.response");
  });
});

describe("hello / server_info wire-version handshake", () => {
  it("helloCommand parses with protocolVersion semver string", () => {
    const p = helloCommand.parse({
      type: "hello",
      protocolVersion: "0.0.1",
    });
    expect(p.protocolVersion).toBe("0.0.1");
  });

  it("helloCommand rejects missing protocolVersion", () => {
    expect(helloCommand.safeParse({ type: "hello" }).success).toBe(false);
  });

  it("serverInfoEvent parses with protocolVersion semver string", () => {
    const p = serverInfoEvent.parse({
      type: "server_info",
      protocolVersion: "0.0.1",
    });
    expect(p.protocolVersion).toBe("0.0.1");
  });

  it("helloCommand is included in clientFrame, serverInfoEvent in daemonFrame", () => {
    expect(
      clientFrame.parse({ type: "hello", protocolVersion: "0.0.1" }).type,
    ).toBe("hello");
    expect(
      daemonFrame.parse({ type: "server_info", protocolVersion: "0.0.1" }).type,
    ).toBe("server_info");
  });
});

describe("health frames", () => {
  it("ping/pong roundtrip", () => {
    const t = Date.now();
    expect(pingFrame.parse({ type: "ping", t }).t).toBe(t);
    expect(pongFrame.parse({ type: "pong", t: t + 5, echoT: t }).echoT).toBe(t);
  });
});

describe("error frame", () => {
  it("accepts known codes", () => {
    expect(
      errorFrame.parse({
        type: "error",
        code: "session_not_found",
        message: "no",
      }).code,
    ).toBe("session_not_found");
  });

  it("rejects unknown code", () => {
    expect(
      errorFrame.safeParse({
        type: "error",
        code: "made_up",
        message: "x",
      }).success,
    ).toBe(false);
  });

  it("accepts incompatible_protocol (sent on hello version mismatch)", () => {
    expect(
      errorFrame.parse({
        type: "error",
        code: "incompatible_protocol",
        message: "client v=2 outside daemon range [1, 1]",
      }).code,
    ).toBe("incompatible_protocol");
  });
});

describe("clientFrame union (commands only — no application-layer handshake)", () => {
  it("accepts ping and commands", () => {
    expect(clientFrame.parse({ type: "ping", t: 0 }).type).toBe("ping");
    expect(
      clientFrame.parse({
        type: "subscribe",
        requestId: "r1",
        sessionId: "s",
      }).type,
    ).toBe("subscribe");
    expect(
      clientFrame.parse({
        type: "unsubscribe",
        requestId: "r2",
        sessionId: "s",
      }).type,
    ).toBe("unsubscribe");
    expect(
      clientFrame.parse({
        type: "interrupt",
        requestId: "r3",
        sessionId: "s",
      }).type,
    ).toBe("interrupt");
  });

  it("rejects daemon-only frames sent by a client", () => {
    expect(
      clientFrame.safeParse({
        type: "session.updated",
        sessionId: "x",
        lastModified: 0,
      }).success,
    ).toBe(false);
    expect(
      clientFrame.safeParse({
        type: "sendPrompt.response",
        requestId: "r",
      }).success,
    ).toBe(false);
  });
});

describe("daemonFrame union", () => {
  it("accepts events + responses", () => {
    expect(
      daemonFrame.parse({
        type: "session.updated",
        sessionId: "s",
        lastModified: 0,
      }).type,
    ).toBe("session.updated");
    expect(
      daemonFrame.parse({
        type: "subscribe.response",
        requestId: "r",
        sessionId: "s",
        settled: [],
        cursor: 0,
      }).type,
    ).toBe("subscribe.response");
    expect(
      daemonFrame.parse({
        type: "event",
        sessionId: "s",
        cursor: 1,
        delta: { kind: "turn_started" },
      }).type,
    ).toBe("event");
    expect(
      daemonFrame.parse({
        type: "sendPrompt.response",
        requestId: "r",
      }).type,
    ).toBe("sendPrompt.response");
  });

  it("rejects client-only frames sent by daemon", () => {
    expect(
      daemonFrame.safeParse({
        type: "sendPrompt",
        sessionId: "s",
        text: "x",
      }).success,
    ).toBe(false);
  });
});

describe("getModels schemas", () => {
  it("command is a bare request with no params", () => {
    expect(getModelsCommand.parse({ type: "getModels", requestId: "r1" }).type)
      .toBe("getModels");
  });

  it("response accepts a minimal entry (only required fields)", () => {
    const r = getModelsResponse.parse({
      type: "getModels.response",
      requestId: "r1",
      models: [
        {
          model: "claude-haiku-4-5-20251001",
          displayName: "Haiku 4.5",
          isDefault: false,
        },
      ],
    });
    expect(r.models[0].supportedEffortLevels).toBeUndefined();
  });

  it("response accepts an entry with all optional fields populated", () => {
    const r = getModelsResponse.parse({
      type: "getModels.response",
      requestId: "r1",
      models: [
        {
          model: "claude-opus-4-7[1m]",
          displayName: "Opus 4.7 1M",
          isDefault: true,
          description: "Best at agentic coding",
          supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
          defaultEffort: "xhigh",
          contextWindow: 1_000_000,
        },
      ],
    });
    expect(r.models[0].supportedEffortLevels).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(r.models[0].defaultEffort).toBe("xhigh");
    expect(r.models[0].contextWindow).toBe(1_000_000);
  });

  it("response accepts defaultEffort independently (max remains a valid wire value)", () => {
    // Wire schema deliberately retains 'max' so historical sessions
    // with effort=max parse cleanly even though picker won't offer it.
    const r = getModelsResponse.parse({
      type: "getModels.response",
      requestId: "r1",
      models: [
        {
          model: "x",
          displayName: "X",
          isDefault: true,
          supportedEffortLevels: ["high", "max"],
          defaultEffort: "max",
        },
      ],
    });
    expect(r.models[0].defaultEffort).toBe("max");
  });

  it("rejects an invalid effort level", () => {
    expect(
      getModelsResponse.safeParse({
        type: "getModels.response",
        requestId: "r1",
        models: [
          {
            model: "x",
            displayName: "X",
            isDefault: false,
            supportedEffortLevels: ["ultra"],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("plumbs through both top-level unions", () => {
    expect(
      clientFrame.parse({ type: "getModels", requestId: "r1" }).type,
    ).toBe("getModels");
    expect(
      daemonFrame.parse({
        type: "getModels.response",
        requestId: "r1",
        models: [],
      }).type,
    ).toBe("getModels.response");
  });
});

// ─── V0 image-attachment / extended-metadata schema additions ─────────────
//
// These tests exist mostly as a written contract — they pin down the
// schema shape so a careless rename / field-typo in index.ts is caught
// at test time rather than at iOS runtime. They do NOT exercise the
// daemon emitter (Phase 2) or mobile renderer (Phase 3+) for these
// fields; those are integration concerns.

describe("imageAttachment schema", () => {
  it("accepts JPEG with base64 data", () => {
    expect(() =>
      sendPromptCommand.parse({
        type: "sendPrompt",
        requestId: "r",
        sessionId: "s",
        text: "see screenshot",
        images: [{ data: "/9j/4AAQSkZ...", mediaType: "image/jpeg" }],
      }),
    ).not.toThrow();
  });

  it("accepts PNG too", () => {
    expect(() =>
      sendPromptCommand.parse({
        type: "sendPrompt",
        requestId: "r",
        sessionId: "s",
        text: "",
        images: [{ data: "iVBORw0KGgo...", mediaType: "image/png" }],
      }),
    ).not.toThrow();
  });

  it("rejects unsupported media types (heic/webp/gif)", () => {
    expect(
      sendPromptCommand.safeParse({
        type: "sendPrompt",
        requestId: "r",
        sessionId: "s",
        text: "x",
        images: [{ data: "...", mediaType: "image/heic" }],
      }).success,
    ).toBe(false);
  });

  it("sendPrompt without images still parses (back-compat)", () => {
    const parsed = sendPromptCommand.parse({
      type: "sendPrompt",
      requestId: "r",
      sessionId: "s",
      text: "plain text",
    });
    expect(parsed.images).toBeUndefined();
  });
});

describe("user_message with images", () => {
  it("carries images inline in timeline", () => {
    const res = getMessagesResponse.parse({
      type: "getMessages.response",
      requestId: "g",
      items: [
        {
          type: "user_message",
          uuid: "m-img",
          text: "see attached",
          images: [{ data: "/9j/...", mediaType: "image/jpeg" }],
        },
      ],
    });
    const first = res.items[0];
    if (first?.type !== "user_message")
      throw new Error("expected user_message");
    expect(first.images).toHaveLength(1);
    expect(first.images?.[0]?.mediaType).toBe("image/jpeg");
  });

  it("user_message without images still parses (back-compat)", () => {
    const res = getMessagesResponse.parse({
      type: "getMessages.response",
      requestId: "g",
      items: [{ type: "user_message", uuid: "m", text: "no images here" }],
    });
    expect(res.items).toHaveLength(1);
  });
});

describe("assistant_message stopReason", () => {
  it("null stopReason is significant — encodes user-interrupted", () => {
    const res = getMessagesResponse.parse({
      type: "getMessages.response",
      requestId: "g",
      items: [
        {
          type: "assistant_message",
          uuid: "m",
          text: "(interrupted mid-stream)",
          stopReason: null,
        },
      ],
    });
    const first = res.items[0];
    if (first?.type !== "assistant_message")
      throw new Error("expected assistant_message");
    // null is preserved (vs being normalized away to undefined)
    expect(first.stopReason).toBeNull();
  });

  it("accepts every documented stop_reason enum value", () => {
    const values = [
      "end_turn",
      "tool_use",
      "max_tokens",
      "stop_sequence",
      "pause_turn",
      "refusal",
      "model_context_window_exceeded",
    ] as const;
    for (const v of values) {
      expect(() =>
        getMessagesResponse.parse({
          type: "getMessages.response",
          requestId: "g",
          items: [
            { type: "assistant_message", uuid: "m", text: "x", stopReason: v },
          ],
        }),
      ).not.toThrow();
    }
  });

  it("rejects unknown stop_reason values", () => {
    expect(
      getMessagesResponse.safeParse({
        type: "getMessages.response",
        requestId: "g",
        items: [
          {
            type: "assistant_message",
            uuid: "m",
            text: "x",
            stopReason: "completed_normally",
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("toolCallDetail — new V0 variants", () => {
  function makeToolCall<T>(detail: T) {
    return {
      type: "tool_call" as const,
      callId: "tu",
      name: "X",
      summary: "x",
      status: "completed" as const,
      error: null,
      detail,
    };
  }
  function parseOne(detail: unknown) {
    return getMessagesResponse.parse({
      type: "getMessages.response",
      requestId: "g",
      items: [makeToolCall(detail)],
    });
  }

  it("bash variant carries runInBackground + taskId", () => {
    const res = parseOne({
      type: "bash",
      command: "pnpm dev",
      description: "Start menubar dev server",
      output: "",
      runInBackground: true,
      taskId: "b3v2ethee",
    });
    const item = res.items[0];
    if (item?.type !== "tool_call" || item.detail.type !== "bash")
      throw new Error("expected bash detail");
    expect(item.detail.runInBackground).toBe(true);
    expect(item.detail.taskId).toBe("b3v2ethee");
  });

  it("bash without background fields still parses (back-compat)", () => {
    expect(() =>
      parseOne({ type: "bash", command: "ls", output: "" }),
    ).not.toThrow();
  });

  it("agent variant", () => {
    expect(() =>
      parseOne({
        type: "agent",
        subagentType: "Explore",
        description: "Verify SDK image persistence",
        prompt: "Read x and report y...",
        output: "Found that...",
      }),
    ).not.toThrow();
  });

  it("web_fetch variant", () => {
    expect(() =>
      parseOne({
        type: "web_fetch",
        url: "https://example.com/api",
        prompt: "extract X",
        output: "the extracted X",
      }),
    ).not.toThrow();
  });

  it("web_search variant", () => {
    expect(() =>
      parseOne({
        type: "web_search",
        query: "react native keyboard controller",
        output: "1. Title - URL\n2. Title - URL",
      }),
    ).not.toThrow();
  });

  it("task_create + task_update + task_stop carry taskId", () => {
    expect(() =>
      parseOne({
        type: "task_create",
        taskId: "1",
        subject: "Install foo",
        activeForm: "Installing foo",
      }),
    ).not.toThrow();
    expect(() =>
      parseOne({
        type: "task_update",
        taskId: "1",
        status: "in_progress",
      }),
    ).not.toThrow();
    expect(() => parseOne({ type: "task_stop", taskId: "1" })).not.toThrow();
  });

  it("task_update status enum is closed", () => {
    expect(
      getMessagesResponse.safeParse({
        type: "getMessages.response",
        requestId: "g",
        items: [
          makeToolCall({
            type: "task_update",
            taskId: "1",
            status: "in-progress", // hyphen instead of underscore
          }),
        ],
      }).success,
    ).toBe(false);
  });

  it("ask_user variant carries questions + optional answers", () => {
    expect(() =>
      parseOne({
        type: "ask_user",
        questions: [
          {
            question: "Which font?",
            header: "Font choice",
            multiSelect: false,
            options: [
              { label: "Inter", description: "Modern sans-serif" },
              { label: "Mono", description: "Monospace for code" },
            ],
          },
        ],
        answers: ["Inter"],
      }),
    ).not.toThrow();
  });

  it("schedule_wakeup variant", () => {
    expect(() =>
      parseOne({
        type: "schedule_wakeup",
        delaySeconds: 90,
        reason: "check dev server boot",
        prompt: "Read /tmp/.../tasks/X.output and report",
      }),
    ).not.toThrow();
  });

  it("monitor variant", () => {
    expect(() =>
      parseOne({
        type: "monitor",
        command: "gh pr checks 123 --watch",
        description: "Watch PR CI status",
        taskId: "m9k2ab",
        output: "Started watching...",
      }),
    ).not.toThrow();
  });

  it("unknown variant remains the fallback for unrecognized SDK tools", () => {
    expect(() =>
      parseOne({
        type: "unknown",
        toolName: "mcp__sentry__list_errors",
        input: { project_id: "abc" },
        output: "no errors",
      }),
    ).not.toThrow();
  });
});
