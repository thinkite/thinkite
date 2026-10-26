import { describe, expect, it } from "vitest";
import {
  decodePairOfferPayload,
  encodePairOffer,
  fromPairOfferWire,
  isProtocolCompatible,
  outdatedSide,
  PAIR_OFFER_VERSION,
  PROTOCOL_VERSION,
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

  it("decodes a scanned offer and rejects anything else", () => {
    expect(fromPairOfferWire({ v: 2, k: "AAAA", s: "mac" })).toEqual({
      type: "pair.offer",
      v: 2,
      daemonIdentityPublicKey: "AAAA",
      serviceName: "mac",
    });
    for (const bad of [
      null,
      "x",
      { v: 2, s: "mac" },
      { v: 2, k: "AAAA" },
      { v: "2", k: "AAAA", s: "mac" },
      { v: 2.5, k: "AAAA", s: "mac" },
    ])
      expect(() => fromPairOfferWire(bad)).toThrow("not a pair offer");
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
