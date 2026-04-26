import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSidecodeHome } from "./home.js";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { PairingService } from "./pairing.js";

/**
 * Wires home + identity + known-clients + pairing together as the daemon
 * would in production. Simulates the full client pair flow against a real
 * filesystem (in a tmpdir) without any network — Day 3 will replace the
 * direct verifyProof() call with a WS message round-trip.
 */
describe("pairing integration", () => {
  let originalEnv: string | undefined;
  let homeRoot: string;

  beforeEach(() => {
    originalEnv = process.env.SIDECODE_HOME;
    homeRoot = mkdtempSync(join(tmpdir(), "sidecode-int-"));
    process.env.SIDECODE_HOME = homeRoot;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SIDECODE_HOME;
    else process.env.SIDECODE_HOME = originalEnv;
    rmSync(homeRoot, { recursive: true, force: true });
  });

  it("completes full pair round-trip and persists client to disk", () => {
    // Server-side bootstrap, exactly as bin/sidecode.ts would do.
    const home = resolveSidecodeHome();
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known);

    // Server-side: produce offer.
    const { offer, challenge } = pairing.createOffer("integration-test");
    expect(offer.daemonPubkey).toBe(identity.publicKeyB64);
    expect(offer.fingerprint).toBe(identity.fingerprint);

    // Client-side: ephemeral keypair + correct sign over hash(challenge||clientPub).
    const { privateKey: clientPriv, publicKey: clientPub } =
      generateKeyPairSync("ed25519");
    const clientPubB64 = (clientPub.export({ format: "jwk" }) as { x: string }).x;
    const hash = createHash("sha256")
      .update(Buffer.from(offer.challenge, "base64url"))
      .update(Buffer.from(clientPubB64, "base64url"))
      .digest();
    const sig = cryptoSign(null, hash, clientPriv);
    const proof = {
      type: "pair.proof" as const,
      clientPubkey: clientPubB64,
      signature: Buffer.from(sig).toString("base64url"),
    };

    // Server-side: verify.
    const result = pairing.verifyProof(challenge, proof);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.client.publicKeyB64).toBe(clientPubB64);

    // Persistence sanity: known_clients.json on disk has exactly one entry.
    const reloaded = KnownClients.load(home);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.has(result.client.fingerprint)).toBe(true);

    // File format snapshot: version 1, contains our client entry.
    const raw = JSON.parse(
      readFileSync(join(home, "known_clients.json"), "utf8"),
    ) as { v: number; clients: Array<{ fingerprint: string }> };
    expect(raw.v).toBe(1);
    expect(raw.clients[0]?.fingerprint).toBe(result.client.fingerprint);
  });

  it("identity is stable across daemon restarts", () => {
    // First "boot"
    const home = resolveSidecodeHome();
    const id1 = loadOrCreateIdentity(home);
    // Second "boot" — same home, should load not regenerate.
    const id2 = loadOrCreateIdentity(home);
    expect(id2.publicKeyB64).toBe(id1.publicKeyB64);
    expect(id2.fingerprint).toBe(id1.fingerprint);
  });

  it("known clients persist across simulated daemon restart", () => {
    // First boot: pair a client.
    {
      const home = resolveSidecodeHome();
      const identity = loadOrCreateIdentity(home);
      const known = KnownClients.load(home);
      const pairing = new PairingService(identity, known);
      const { offer, challenge } = pairing.createOffer("first-boot");
      const { privateKey, publicKey } = generateKeyPairSync("ed25519");
      const clientPubB64 = (publicKey.export({ format: "jwk" }) as { x: string }).x;
      const hash = createHash("sha256")
        .update(Buffer.from(offer.challenge, "base64url"))
        .update(Buffer.from(clientPubB64, "base64url"))
        .digest();
      const proof = {
        type: "pair.proof" as const,
        clientPubkey: clientPubB64,
        signature: Buffer.from(cryptoSign(null, hash, privateKey)).toString(
          "base64url",
        ),
      };
      expect(pairing.verifyProof(challenge, proof).ok).toBe(true);
    }

    // Second boot: known client should still be there.
    {
      const home = resolveSidecodeHome();
      const known = KnownClients.load(home);
      expect(known.list()).toHaveLength(1);
    }
  });
});
