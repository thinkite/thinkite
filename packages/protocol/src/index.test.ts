import { describe, expect, it } from "vitest";
import {
  approveCommand,
  buildClientAuthTranscript,
  buildTranscript,
  CLIENT_AUTH_LABEL,
  clientAuthFrame,
  clientFrame,
  clientHelloFrame,
  command,
  continueOnDesktopCommand,
  continueOnDesktopResponse,
  daemonFrame,
  deleteSessionCommand,
  deleteSessionResponse,
  errorFrame,
  event,
  getMessagesCommand,
  getMessagesResponse,
  HANDSHAKE_DOMAIN_TAG,
  HANDSHAKE_VERSION,
  handshakeRejectFrame,
  listSessionsCommand,
  listSessionsResponse,
  pairOfferFrame,
  pingFrame,
  pongFrame,
  PROTOCOL_VERSION,
  sendPromptCommand,
  serverHelloFrame,
  serverReadyFrame,
  sessionDivergedEvent,
  sessionInfo,
  type TranscriptInput,
} from "./index.js";

describe("protocol version", () => {
  it("is exported as a non-empty string", () => {
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("handshake constants", () => {
  it("HANDSHAKE_VERSION starts at 1", () => {
    expect(HANDSHAKE_VERSION).toBe(1);
  });

  it("HANDSHAKE_DOMAIN_TAG is the V0 protocol tag", () => {
    expect(HANDSHAKE_DOMAIN_TAG).toBe("sidecode-handshake-v1");
  });

  it("CLIENT_AUTH_LABEL is 'client-auth'", () => {
    expect(CLIENT_AUTH_LABEL).toBe("client-auth");
  });
});

describe("pair.offer frame", () => {
  const valid = {
    type: "pair.offer" as const,
    v: 1,
    daemonFingerprint: "988d6cb2baa153ef",
    daemonIdentityPublicKey: "AAAA",
    daemonAddress: "ws://192.168.1.10:41234",
    serviceName: "sidecode-mac",
    expiresAt: 1700000000000,
  };

  it("parses a stateless offer (no sessionId)", () => {
    const parsed = pairOfferFrame.parse(valid);
    expect(parsed.daemonFingerprint).toBe("988d6cb2baa153ef");
    expect(parsed.v).toBe(1);
    // Confirm sessionId is NOT a field on the offer.
    expect((parsed as Record<string, unknown>).sessionId).toBeUndefined();
  });

  it("rejects when daemonAddress is missing", () => {
    const { daemonAddress: _, ...rest } = valid;
    expect(pairOfferFrame.safeParse(rest).success).toBe(false);
  });

  it("rejects when daemonIdentityPublicKey is missing", () => {
    const { daemonIdentityPublicKey: _, ...rest } = valid;
    expect(pairOfferFrame.safeParse(rest).success).toBe(false);
  });
});

describe("client.hello frame", () => {
  const valid = {
    type: "client.hello" as const,
    v: 1,
    sessionId: "abc",
    mode: "qr_bootstrap" as const,
    clientFingerprint: "4998b6ca7d7474b8",
    clientIdentityPublicKey: "BBBB",
    clientNonce: "CCCC",
  };

  it("parses qr_bootstrap mode (offer-echo fields optional at schema level)", () => {
    expect(clientHelloFrame.parse(valid).mode).toBe("qr_bootstrap");
  });

  it("parses qr_bootstrap with offer-echo fields", () => {
    const parsed = clientHelloFrame.parse({
      ...valid,
      offerExpiresAt: 1700000000000,
      offerDaemonFingerprint: "988d6cb2baa153ef",
    });
    expect(parsed.offerExpiresAt).toBe(1700000000000);
    expect(parsed.offerDaemonFingerprint).toBe("988d6cb2baa153ef");
  });

  it("parses trusted_reconnect mode", () => {
    expect(
      clientHelloFrame.parse({ ...valid, mode: "trusted_reconnect" }).mode,
    ).toBe("trusted_reconnect");
  });

  it("rejects unknown mode", () => {
    expect(
      clientHelloFrame.safeParse({ ...valid, mode: "wat" }).success,
    ).toBe(false);
  });
});

describe("server.hello frame", () => {
  const valid = {
    type: "server.hello" as const,
    v: 1,
    sessionId: "abc",
    mode: "qr_bootstrap" as const,
    daemonFingerprint: "988d6cb2baa153ef",
    daemonIdentityPublicKey: "AAAA",
    serverNonce: "DDDD",
    clientNonce: "CCCC",
    keyEpoch: 1,
    expiresAt: 1700000000000,
    daemonSignature: "EEEE",
  };

  it("parses with all required fields", () => {
    const parsed = serverHelloFrame.parse(valid);
    expect(parsed.daemonSignature).toBe("EEEE");
    expect(parsed.keyEpoch).toBe(1);
  });

  it("rejects missing daemonSignature", () => {
    const { daemonSignature: _, ...rest } = valid;
    expect(serverHelloFrame.safeParse(rest).success).toBe(false);
  });
});

describe("client.auth frame", () => {
  it("parses with required fields", () => {
    const parsed = clientAuthFrame.parse({
      type: "client.auth",
      v: 1,
      sessionId: "abc",
      clientFingerprint: "4998b6ca7d7474b8",
      keyEpoch: 1,
      clientSignature: "FFFF",
    });
    expect(parsed.clientSignature).toBe("FFFF");
  });
});

describe("server.ready frame", () => {
  it("parses with required fields", () => {
    const parsed = serverReadyFrame.parse({
      type: "server.ready",
      v: 1,
      sessionId: "abc",
      daemonFingerprint: "988d6cb2baa153ef",
      keyEpoch: 1,
    });
    expect(parsed.daemonFingerprint).toBe("988d6cb2baa153ef");
  });
});

describe("handshake.reject frame", () => {
  it("parses with all reject codes", () => {
    const codes = [
      "invalid_signature",
      "session_expired",
      "session_unknown",
      "client_unknown",
      "client_already_paired",
      "version_mismatch",
      "mode_mismatch",
      "internal",
    ] as const;
    for (const code of codes) {
      const parsed = handshakeRejectFrame.parse({
        type: "handshake.reject",
        v: 1,
        code,
        message: `something about ${code}`,
      });
      expect(parsed.code).toBe(code);
    }
  });

  it("rejects unknown reject code", () => {
    expect(
      handshakeRejectFrame.safeParse({
        type: "handshake.reject",
        v: 1,
        code: "made_up_code",
        message: "x",
      }).success,
    ).toBe(false);
  });

  it("sessionId is optional (early-handshake rejects may not have one)", () => {
    expect(
      handshakeRejectFrame.parse({
        type: "handshake.reject",
        v: 1,
        code: "version_mismatch",
        message: "client v=99",
      }).sessionId,
    ).toBeUndefined();
  });
});

describe("buildTranscript", () => {
  const baseInput: TranscriptInput = {
    sessionId: "abc-123",
    protocolVersion: 1,
    mode: "qr_bootstrap",
    keyEpoch: 1,
    daemonFingerprint: "988d6cb2baa153ef",
    clientFingerprint: "4998b6ca7d7474b8",
    daemonIdentityPublicKey: "AAAA",
    clientIdentityPublicKey: "BBBB",
    clientNonce: "CCCC",
    serverNonce: "DDDD",
    expiresAt: 1700000000000,
  };

  it("produces deterministic bytes for the same input", () => {
    const a = buildTranscript(baseInput);
    const b = buildTranscript(baseInput);
    expect(a).toEqual(b);
  });

  it("changes if any field changes", () => {
    const original = buildTranscript(baseInput);
    const tampered = buildTranscript({ ...baseInput, sessionId: "abc-999" });
    expect(original).not.toEqual(tampered);
  });

  it("starts with the length-prefixed domain tag", () => {
    const t = buildTranscript(baseInput);
    // first 4 bytes = u32 BE length of HANDSHAKE_DOMAIN_TAG
    const tagLen = HANDSHAKE_DOMAIN_TAG.length;
    expect(t[0]).toBe(0);
    expect(t[1]).toBe(0);
    expect(t[2]).toBe(0);
    expect(t[3]).toBe(tagLen);
    const decoded = new TextDecoder().decode(t.slice(4, 4 + tagLen));
    expect(decoded).toBe(HANDSHAKE_DOMAIN_TAG);
  });

  it("client-auth variant ends with the label bytes", () => {
    const baseBytes = buildTranscript(baseInput);
    const authBytes = buildClientAuthTranscript(baseInput);
    expect(authBytes.length).toBe(baseBytes.length + CLIENT_AUTH_LABEL.length);
    const trailer = new TextDecoder().decode(authBytes.slice(baseBytes.length));
    expect(trailer).toBe(CLIENT_AUTH_LABEL);
  });

  it("base variant differs from client-auth variant (domain separation)", () => {
    expect(buildTranscript(baseInput)).not.toEqual(
      buildClientAuthTranscript(baseInput),
    );
  });

  it("mode change produces different transcript", () => {
    const a = buildTranscript({ ...baseInput, mode: "qr_bootstrap" });
    const b = buildTranscript({ ...baseInput, mode: "trusted_reconnect" });
    expect(a).not.toEqual(b);
  });
});

// ─── Existing sections (unchanged content) ────────────────────────────────

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
  it("accepts a minimal sendPrompt", () => {
    expect(
      sendPromptCommand.parse({
        type: "sendPrompt",
        sessionId: "x",
        text: "hi",
      }).text,
    ).toBe("hi");
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
    expect(
      command.parse({ type: "listSessions", requestId: "r1" }).type,
    ).toBe("listSessions");
    expect(
      command.parse({ type: "deleteSession", requestId: "r2", sessionId: "s" })
        .type,
    ).toBe("deleteSession");
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
      model: "Opus 4.7",
      completedTurns: 21,
      isArchived: false,
    });
    expect(p.cwd).not.toBe(p.originCwd);
    expect(p.completedTurns).toBe(21);
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

  it("getMessages response carries SessionMessage[] (message left as unknown)", () => {
    const res = getMessagesResponse.parse({
      type: "getMessages.response",
      requestId: "g1",
      messages: [
        {
          type: "user",
          uuid: "m-1",
          sessionId: "cli-abc",
          message: { role: "user", content: "hi" },
        },
        {
          type: "assistant",
          uuid: "m-2",
          sessionId: "cli-abc",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
          },
        },
      ],
    });
    expect(res.messages).toHaveLength(2);
    expect(res.messages[0]?.type).toBe("user");
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
        messages: [],
      }).type,
    ).toBe("getMessages.response");
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
});

describe("clientFrame union (handshake + commands)", () => {
  it("accepts client.hello", () => {
    expect(
      clientFrame.parse({
        type: "client.hello",
        v: 1,
        sessionId: "x",
        mode: "qr_bootstrap",
        clientFingerprint: "f",
        clientIdentityPublicKey: "k",
        clientNonce: "n",
      }).type,
    ).toBe("client.hello");
  });

  it("accepts client.auth", () => {
    expect(
      clientFrame.parse({
        type: "client.auth",
        v: 1,
        sessionId: "x",
        clientFingerprint: "f",
        keyEpoch: 1,
        clientSignature: "s",
      }).type,
    ).toBe("client.auth");
  });

  it("accepts ping and commands", () => {
    expect(clientFrame.parse({ type: "ping", t: 0 }).type).toBe("ping");
    expect(
      clientFrame.parse({ type: "subscribe", sessionId: "s" }).type,
    ).toBe("subscribe");
  });

  it("rejects daemon-only frames sent by a client", () => {
    expect(
      clientFrame.safeParse({
        type: "server.hello",
        v: 1,
        sessionId: "x",
        mode: "qr_bootstrap",
        daemonFingerprint: "d",
        daemonIdentityPublicKey: "k",
        serverNonce: "n",
        clientNonce: "n",
        keyEpoch: 1,
        expiresAt: 0,
        daemonSignature: "s",
      }).success,
    ).toBe(false);
    expect(
      clientFrame.safeParse({
        type: "session.updated",
        sessionId: "x",
        lastModified: 0,
      }).success,
    ).toBe(false);
  });
});

describe("daemonFrame union", () => {
  it("accepts handshake frames + events + responses", () => {
    expect(
      daemonFrame.parse({
        type: "server.hello",
        v: 1,
        sessionId: "x",
        mode: "qr_bootstrap",
        daemonFingerprint: "d",
        daemonIdentityPublicKey: "k",
        serverNonce: "n",
        clientNonce: "n",
        keyEpoch: 1,
        expiresAt: 0,
        daemonSignature: "s",
      }).type,
    ).toBe("server.hello");
    expect(
      daemonFrame.parse({
        type: "session.updated",
        sessionId: "s",
        lastModified: 0,
      }).type,
    ).toBe("session.updated");
    expect(
      daemonFrame.parse({
        type: "handshake.reject",
        v: 1,
        code: "invalid_signature",
        message: "no",
      }).type,
    ).toBe("handshake.reject");
  });

  it("rejects client-only frames sent by daemon", () => {
    expect(
      daemonFrame.safeParse({
        type: "client.hello",
        v: 1,
        sessionId: "x",
        mode: "qr_bootstrap",
        clientFingerprint: "f",
        clientIdentityPublicKey: "k",
        clientNonce: "n",
      }).success,
    ).toBe(false);
    expect(
      daemonFrame.safeParse({
        type: "sendPrompt",
        sessionId: "s",
        text: "x",
      }).success,
    ).toBe(false);
  });
});
