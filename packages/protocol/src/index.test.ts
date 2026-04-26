import { describe, expect, it } from "vitest";
import {
  approveCommand,
  clientFrame,
  command,
  daemonFrame,
  deleteSessionCommand,
  deleteSessionResponse,
  errorFrame,
  event,
  listSessionsCommand,
  listSessionsResponse,
  PAIR_OFFER_VERSION,
  pairAcceptFrame,
  pairOfferFrame,
  pairProofFrame,
  pingFrame,
  pongFrame,
  PROTOCOL_VERSION,
  sendPromptCommand,
  sessionDivergedEvent,
  sessionInfo,
} from "./index.js";

describe("protocol version", () => {
  it("is exported as a non-empty string", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("event union", () => {
  it("accepts a well-formed session.updated event", () => {
    const parsed = event.parse({
      type: "session.updated",
      sessionId: "abc",
      lastModified: 1700000000,
    });
    expect(parsed.type).toBe("session.updated");
  });

  it("rejects an unknown event type", () => {
    expect(event.safeParse({ type: "session.bogus" }).success).toBe(false);
  });

  it("requires session.diverged to carry at least 2 branches", () => {
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
  it("accepts a minimal sendPrompt", () => {
    const parsed = sendPromptCommand.parse({
      type: "sendPrompt",
      sessionId: "abc",
      text: "hello",
    });
    expect(parsed.text).toBe("hello");
  });

  it("rejects sendPrompt with extra unknown fields strictly? no — z.object is permissive by default", () => {
    // Documenting: z.object passes through unknown fields silently. If we
    // ever want to reject them (e.g. catch a renamed field at protocol bumps),
    // switch to z.strictObject. For V0 we accept the lenient default.
    const parsed = sendPromptCommand.parse({
      type: "sendPrompt",
      sessionId: "abc",
      text: "hello",
      maxBudgetUsd: 0.5,
    });
    expect(parsed.text).toBe("hello");
    expect((parsed as { maxBudgetUsd?: number }).maxBudgetUsd).toBeUndefined();
  });

  it("rejects approve with an out-of-enum decision", () => {
    expect(
      approveCommand.safeParse({
        type: "approve",
        requestId: "x",
        decision: "maybe",
      }).success,
    ).toBe(false);
  });

  it("includes listSessions and deleteSession", () => {
    expect(
      command.parse({ type: "listSessions", requestId: "r1" }).type,
    ).toBe("listSessions");
    expect(
      command.parse({ type: "deleteSession", requestId: "r2", sessionId: "s" })
        .type,
    ).toBe("deleteSession");
  });
});

describe("pairing handshake", () => {
  it("exports PAIR_OFFER_VERSION as a non-empty string", () => {
    expect(PAIR_OFFER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("parses pair.offer with all required fields including v", () => {
    const parsed = pairOfferFrame.parse({
      type: "pair.offer",
      v: PAIR_OFFER_VERSION,
      daemonPubkey: "AAA=",
      fingerprint: "abcdef",
      challenge: "BBB=",
      challengeExpiresAt: 1700000000,
      serviceName: "sidecode-laptop",
    });
    expect(parsed.fingerprint).toBe("abcdef");
    expect(parsed.v).toBe(PAIR_OFFER_VERSION);
  });

  it("accepts an unknown v value at the schema level (caller decides)", () => {
    // The schema is permissive on v so that callers can detect "version
    // mismatch" and show a friendly upgrade prompt, rather than failing
    // the whole parse with a generic literal-mismatch error.
    const result = pairOfferFrame.safeParse({
      type: "pair.offer",
      v: "9.9.9",
      daemonPubkey: "AAA=",
      fingerprint: "abcdef",
      challenge: "BBB=",
      challengeExpiresAt: 1700000000,
      serviceName: "sidecode-laptop",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.v).toBe("9.9.9");
      // Caller is responsible for: if (data.v !== PAIR_OFFER_VERSION) { promptUpgrade() }
    }
  });

  it("rejects pair.offer missing the v field", () => {
    expect(
      pairOfferFrame.safeParse({
        type: "pair.offer",
        daemonPubkey: "AAA=",
        fingerprint: "abcdef",
        challenge: "BBB=",
        challengeExpiresAt: 1700000000,
        serviceName: "sidecode-laptop",
      }).success,
    ).toBe(false);
  });

  it("parses pair.proof and pair.accept", () => {
    expect(
      pairProofFrame.parse({
        type: "pair.proof",
        clientPubkey: "C",
        signature: "S",
      }).type,
    ).toBe("pair.proof");
    expect(
      pairAcceptFrame.parse({
        type: "pair.accept",
        clientFingerprint: "f",
      }).type,
    ).toBe("pair.accept");
  });

  it("rejects pair.offer missing required fields", () => {
    expect(
      pairOfferFrame.safeParse({ type: "pair.offer", daemonPubkey: "x" })
        .success,
    ).toBe(false);
  });
});

describe("session metadata", () => {
  it("parses a minimal SessionInfo (only required fields)", () => {
    const parsed = sessionInfo.parse({
      sessionId: "s1",
      summary: "Hello",
      lastModified: 1700000000,
    });
    expect(parsed.sessionId).toBe("s1");
    expect(parsed.cwd).toBeUndefined();
  });

  it("parses a full SessionInfo with all 10 fields", () => {
    const parsed = sessionInfo.parse({
      sessionId: "s1",
      summary: "Hello",
      lastModified: 1700000000,
      fileSize: 4096,
      customTitle: "My session",
      firstPrompt: "Hi",
      gitBranch: "main",
      cwd: "/Users/x",
      tag: null,
      createdAt: 1690000000,
    });
    expect(parsed.tag).toBeNull();
  });

  it("rejects SessionInfo missing sessionId", () => {
    expect(
      sessionInfo.safeParse({ summary: "x", lastModified: 0 }).success,
    ).toBe(false);
  });
});

describe("request/response correlation", () => {
  it("listSessions roundtrip preserves requestId", () => {
    const reqId = "req-abc";
    const cmd = listSessionsCommand.parse({
      type: "listSessions",
      requestId: reqId,
      dir: "/tmp",
    });
    const res = listSessionsResponse.parse({
      type: "listSessions.response",
      requestId: reqId,
      sessions: [
        { sessionId: "s1", summary: "x", lastModified: 1 },
        { sessionId: "s2", summary: "y", lastModified: 2 },
      ],
    });
    expect(cmd.requestId).toBe(res.requestId);
    expect(res.sessions).toHaveLength(2);
  });

  it("deleteSession roundtrip", () => {
    const cmd = deleteSessionCommand.parse({
      type: "deleteSession",
      requestId: "r",
      sessionId: "s",
    });
    const res = deleteSessionResponse.parse({
      type: "deleteSession.response",
      requestId: "r",
    });
    expect(cmd.requestId).toBe(res.requestId);
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
  it("accepts valid code", () => {
    const parsed = errorFrame.parse({
      type: "error",
      code: "session_not_found",
      message: "no such session: s1",
      requestId: "r1",
    });
    expect(parsed.code).toBe("session_not_found");
  });

  it("rejects unknown error code", () => {
    expect(
      errorFrame.safeParse({
        type: "error",
        code: "some_made_up_code",
        message: "x",
      }).success,
    ).toBe(false);
  });
});

describe("clientFrame union", () => {
  it("accepts pair.proof, ping, and any command", () => {
    expect(clientFrame.parse({ type: "ping", t: 0 }).type).toBe("ping");
    expect(
      clientFrame.parse({
        type: "pair.proof",
        clientPubkey: "p",
        signature: "s",
      }).type,
    ).toBe("pair.proof");
    expect(
      clientFrame.parse({ type: "subscribe", sessionId: "s" }).type,
    ).toBe("subscribe");
  });

  it("rejects daemon-only frames coming from a client", () => {
    expect(
      clientFrame.safeParse({
        type: "pong",
        t: 0,
        echoT: 0,
      }).success,
    ).toBe(false);
    expect(
      clientFrame.safeParse({
        type: "session.updated",
        sessionId: "s",
        lastModified: 0,
      }).success,
    ).toBe(false);
  });
});

describe("daemonFrame union", () => {
  it("accepts events, responses, pairing, pong, error", () => {
    expect(
      daemonFrame.parse({
        type: "session.updated",
        sessionId: "s",
        lastModified: 0,
      }).type,
    ).toBe("session.updated");
    expect(
      daemonFrame.parse({
        type: "listSessions.response",
        requestId: "r",
        sessions: [],
      }).type,
    ).toBe("listSessions.response");
    expect(
      daemonFrame.parse({
        type: "pair.reject",
        reason: "bad signature",
      }).type,
    ).toBe("pair.reject");
  });

  it("rejects client-only frames coming from the daemon", () => {
    expect(
      daemonFrame.safeParse({
        type: "sendPrompt",
        sessionId: "s",
        text: "x",
      }).success,
    ).toBe(false);
  });
});
