import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { CHALLENGE_TTL_MS, PairingService } from "./pairing.js";

interface MockClient {
  publicKeyB64: string;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
}

function makeMockClient(): MockClient {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { publicKeyB64: jwk.x, privateKey };
}

function signProof(client: MockClient, challenge: string) {
  const challengeBytes = Buffer.from(challenge, "base64url");
  const clientPubBytes = Buffer.from(client.publicKeyB64, "base64url");
  const hash = createHash("sha256")
    .update(challengeBytes)
    .update(clientPubBytes)
    .digest();
  const sig = cryptoSign(null, hash, client.privateKey);
  return {
    type: "pair.proof" as const,
    clientPubkey: client.publicKeyB64,
    signature: Buffer.from(sig).toString("base64url"),
  };
}

describe("PairingService", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-pair-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function makeService(overrides: { clock?: () => number } = {}) {
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    return {
      service: new PairingService(identity, known, overrides),
      identity,
      known,
    };
  }

  it("createOffer returns a well-formed offer with our identity", () => {
    const { service, identity } = makeService();
    const { offer, challenge } = service.createOffer("sidecode-test");
    expect(offer.type).toBe("pair.offer");
    expect(offer.daemonPubkey).toBe(identity.publicKeyB64);
    expect(offer.fingerprint).toBe(identity.fingerprint);
    expect(offer.serviceName).toBe("sidecode-test");
    expect(offer.challenge).toBe(challenge);
    expect(offer.challengeExpiresAt).toBeGreaterThan(Date.now());
  });

  it("happy path: verifyProof accepts a valid signature and persists client", () => {
    const { service, known } = makeService();
    const client = makeMockClient();
    const { offer, challenge } = service.createOffer("sidecode-test");
    const proof = signProof(client, offer.challenge);

    const result = service.verifyProof(challenge, proof);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accepted.type).toBe("pair.accept");
      expect(result.accepted.clientFingerprint).toMatch(/^[0-9a-f]{16}$/);
      expect(result.client.publicKeyB64).toBe(client.publicKeyB64);
    }
    expect(known.list()).toHaveLength(1);
  });

  it("rejects expired challenge", () => {
    let now = 1_000_000;
    const { service } = makeService({ clock: () => now });
    const client = makeMockClient();
    const { challenge } = service.createOffer("test");
    const proof = signProof(client, challenge);
    now += CHALLENGE_TTL_MS + 1;
    const result = service.verifyProof(challenge, proof);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejected.reason).toMatch(/expired/);
  });

  it("rejects unknown challenge", () => {
    const { service } = makeService();
    const client = makeMockClient();
    const result = service.verifyProof(
      "nonsense-challenge",
      signProof(client, "nonsense-challenge"),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.rejected.reason).toMatch(/unknown or already-used/);
  });

  it("rejects bad signature (signed with a different key)", () => {
    const { service } = makeService();
    const honest = makeMockClient();
    const attacker = makeMockClient();
    const { challenge } = service.createOffer("test");
    // Pretend to be the honest client, but sign with attacker's private key.
    const proof = signProof(attacker, challenge);
    proof.clientPubkey = honest.publicKeyB64; // claim wrong pubkey
    const result = service.verifyProof(challenge, proof);
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.rejected.reason).toMatch(/signature verification failed/);
  });

  it("prevents replay — same challenge twice fails on the second attempt", () => {
    const { service } = makeService();
    const client = makeMockClient();
    const { challenge } = service.createOffer("test");
    const proof = signProof(client, challenge);
    expect(service.verifyProof(challenge, proof).ok).toBe(true);
    const replay = service.verifyProof(challenge, proof);
    expect(replay.ok).toBe(false);
    if (!replay.ok)
      expect(replay.rejected.reason).toMatch(/unknown or already-used/);
  });

  it("consumes challenge even on failed verify (replay-safe under failure)", () => {
    const { service } = makeService();
    const honest = makeMockClient();
    const attacker = makeMockClient();
    const { challenge } = service.createOffer("test");
    // First attempt: bad sig — fails AND consumes the challenge.
    const badProof = signProof(attacker, challenge);
    badProof.clientPubkey = honest.publicKeyB64;
    expect(service.verifyProof(challenge, badProof).ok).toBe(false);
    // Second attempt: even with correct sig, challenge already consumed.
    const goodProof = signProof(honest, challenge);
    const second = service.verifyProof(challenge, goodProof);
    expect(second.ok).toBe(false);
    if (!second.ok)
      expect(second.rejected.reason).toMatch(/unknown or already-used/);
  });

  it("rejects malformed client pubkey", () => {
    const { service } = makeService();
    const { challenge } = service.createOffer("test");
    const result = service.verifyProof(challenge, {
      type: "pair.proof",
      clientPubkey: "not-a-real-key",
      signature: "AAAA",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.rejected.reason).toMatch(/invalid client public key/);
  });

  it("rejects re-pair of an already-known client fingerprint", () => {
    const { service } = makeService();
    const client = makeMockClient();
    // First pair succeeds
    const first = service.createOffer("test");
    expect(service.verifyProof(first.challenge, signProof(client, first.challenge)).ok).toBe(true);
    // Second offer + proof from same client should be rejected
    const second = service.createOffer("test");
    const result = service.verifyProof(
      second.challenge,
      signProof(client, second.challenge),
    );
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.rejected.reason).toMatch(/already paired/);
  });

  it("prune() drops expired challenges", () => {
    let now = 1_000_000;
    const { service } = makeService({ clock: () => now });
    service.createOffer("a");
    service.createOffer("b");
    now += CHALLENGE_TTL_MS + 1;
    expect(service.prune()).toBe(2);
  });
});
