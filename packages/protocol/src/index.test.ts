import { describe, expect, it } from "vitest";
import {
  clientFrame,
  command,
  daemonFrame,
  decodePairOfferPayload,
  encodePairOffer,
  errorFrame,
  helloCommand,
  isProtocolCompatible,
  outdatedSide,
  PAIR_OFFER_VERSION,
  PROTOCOL_VERSION,
  pairOfferFrame,
  pingFrame,
  pongFrame,
  serverInfoEvent,
} from "./index.ts";

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

  it("same breaking line during 0.x: patch differences compatible BOTH directions", () => {
    // Bump policy: patch = additive only, old peers harmlessly ignore.
    // The check is symmetric same-`0.minor`-line — deliberately NOT npm
    // caret (which rejects a remote with a LOWER patch than ours).
    if (PROTOCOL_VERSION.startsWith("0.")) {
      const [, minor, patch] = PROTOCOL_VERSION.split(".").map(Number);
      expect(isProtocolCompatible(`0.${minor}.${patch + 5}`)).toBe(true);
      if (patch > 0) {
        expect(isProtocolCompatible(`0.${minor}.${patch - 1}`)).toBe(true);
      }
      expect(isProtocolCompatible(`0.${minor + 1}.0`)).toBe(false);
      if (minor > 0) {
        expect(isProtocolCompatible(`0.${minor - 1}.0`)).toBe(false);
      }
      expect(isProtocolCompatible(`1.0.0`)).toBe(false);
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

describe("outdatedSide", () => {
  it("semver-lower remote → remote is the outdated side", () => {
    const [major, minor, patch] = PROTOCOL_VERSION.split(".").map(Number);
    expect(outdatedSide(`${major}.${minor}.${patch + 1}`)).toBe("local");
    expect(outdatedSide(`${major}.${minor + 1}.0`)).toBe("local");
    expect(outdatedSide(`${major + 1}.0.0`)).toBe("local");
    if (patch > 0) {
      expect(outdatedSide(`${major}.${minor}.${patch - 1}`)).toBe("remote");
    }
    if (minor > 0) {
      expect(outdatedSide(`${major}.${minor - 1}.0`)).toBe("remote");
    }
    if (major > 0) {
      expect(outdatedSide(`${major - 1}.0.0`)).toBe("remote");
    }
  });

  it("equal version → null (a peer rejecting us at OUR version is misbehaving, not outdated)", () => {
    expect(outdatedSide(PROTOCOL_VERSION)).toBe(null);
  });

  it("garbage input → null (caller falls back to direction-neutral copy)", () => {
    expect(outdatedSide("not-a-version")).toBe(null);
    expect(outdatedSide("")).toBe(null);
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

  it("preserves the sender's protocolVersion on incompatible_protocol", () => {
    // The field must be in the schema — z.object strips unknown keys, so
    // a zod-parsed path would silently drop it and iOS couldn't tell
    // which side is outdated.
    expect(
      errorFrame.parse({
        type: "error",
        code: "incompatible_protocol",
        message: "client protocol 0.1.0 is not compatible with daemon 0.2.0",
        protocolVersion: "0.2.0",
      }).protocolVersion,
    ).toBe("0.2.0");
  });
});

describe("command union", () => {
  it("accepts the git and folder commands", () => {
    for (const frame of [
      { type: "getGitStatus", requestId: "r1", cwd: "/p" },
      { type: "subscribeGitStatus", requestId: "r2", cwd: "/p" },
      { type: "unsubscribeGitStatus", requestId: "r3", cwd: "/p" },
      { type: "getWorkingTreeDiff", requestId: "r4", cwd: "/p" },
      { type: "listDirectory", requestId: "r5", path: "~" },
      { type: "getFilesystemRoots", requestId: "r6" },
    ]) {
      expect(command.parse(frame).type).toBe(frame.type);
    }
  });

  it("no longer carries session commands — sessions are opencode's", () => {
    expect(
      command.safeParse({
        type: "sendPrompt",
        requestId: "r",
        sessionId: "s",
        text: "x",
      }).success,
    ).toBe(false);
  });
});

describe("clientFrame union", () => {
  it("accepts hello, ping and commands", () => {
    expect(clientFrame.parse({ type: "ping", t: 0 }).type).toBe("ping");
    expect(
      clientFrame.parse({ type: "getFilesystemRoots", requestId: "r" }).type,
    ).toBe("getFilesystemRoots");
  });

  it("rejects daemon-only frames sent by a client", () => {
    expect(
      clientFrame.safeParse({ type: "gitStatus", cwd: "/p", status: {} })
        .success,
    ).toBe(false);
  });
});

describe("daemonFrame union", () => {
  it("accepts responses", () => {
    expect(
      daemonFrame.parse({
        type: "listDirectory.response",
        requestId: "r",
        path: "/p",
        parent: "/",
        entries: [],
      }).type,
    ).toBe("listDirectory.response");
  });

  it("rejects client-only frames sent by daemon", () => {
    expect(
      daemonFrame.safeParse({
        type: "listDirectory",
        requestId: "r",
        path: "~",
      }).success,
    ).toBe(false);
  });
});
