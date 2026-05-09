import {
  createHash,
  sign as cryptoSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClientAuthTranscript,
  HANDSHAKE_VERSION,
  type TranscriptInput,
} from "@sidecodeapp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSidecodeHome } from "./home.js";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { PairingService } from "./pairing.js";

/**
 * Wires home + identity + known-clients + pairing together as the daemon
 * would in production. Simulates the full client pair flow against a real
 * filesystem (in a tmpdir) without any network — Day 3 will replace the
 * direct processClientHello/processClientAuth calls with a WS handshake.
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

  function freshClient() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    const fingerprint = createHash("sha256")
      .update(Buffer.from(jwk.x, "base64url"))
      .digest("hex")
      .slice(0, 16);
    return { publicKeyB64: jwk.x, privateKey, fingerprint };
  }

  it("completes full qr_bootstrap and persists client to disk", () => {
    const home = resolveSidecodeHome();
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known, {
      daemonAddresses: ["ws://127.0.0.1:41234"],
    });

    const offer = pairing.createOffer("integration-test");
    expect(offer.daemonFingerprint).toBe(identity.fingerprint);
    expect(offer.daemonIdentityPublicKey).toBe(identity.publicKeyB64);
    expect(offer.daemonAddresses).toEqual(["ws://127.0.0.1:41234"]);

    const client = freshClient();
    const sessionId = `int-${Date.now()}`;
    const hello = {
      type: "client.hello" as const,
      v: HANDSHAKE_VERSION,
      sessionId,
      mode: "qr_bootstrap" as const,
      clientFingerprint: client.fingerprint,
      clientIdentityPublicKey: client.publicKeyB64,
      clientNonce: randomBytes(32).toString("base64url"),
      offerExpiresAt: offer.expiresAt,
      offerDaemonFingerprint: offer.daemonFingerprint,
    };

    const helloRes = pairing.processClientHello(hello);
    expect(helloRes.ok).toBe(true);
    if (!helloRes.ok) return;
    expect(helloRes.serverHello.daemonFingerprint).toBe(identity.fingerprint);

    const transcriptInput: TranscriptInput = {
      sessionId,
      protocolVersion: HANDSHAKE_VERSION,
      mode: "qr_bootstrap",
      keyEpoch: helloRes.serverHello.keyEpoch,
      daemonFingerprint: helloRes.serverHello.daemonFingerprint,
      clientFingerprint: client.fingerprint,
      daemonIdentityPublicKey: helloRes.serverHello.daemonIdentityPublicKey,
      clientIdentityPublicKey: client.publicKeyB64,
      clientNonce: hello.clientNonce,
      serverNonce: helloRes.serverHello.serverNonce,
      expiresAt: helloRes.serverHello.expiresAt,
    };
    const sig = cryptoSign(
      null,
      buildClientAuthTranscript(transcriptInput),
      client.privateKey,
    );

    const authRes = pairing.processClientAuth({
      type: "client.auth",
      v: HANDSHAKE_VERSION,
      sessionId,
      clientFingerprint: client.fingerprint,
      keyEpoch: helloRes.serverHello.keyEpoch,
      clientSignature: Buffer.from(sig).toString("base64url"),
    });

    expect(authRes.ok).toBe(true);
    if (!authRes.ok) return;
    expect(authRes.client.fingerprint).toBe(client.fingerprint);

    // Persistence sanity: known_clients.json on disk has exactly one entry.
    const reloaded = KnownClients.load(home);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.has(client.fingerprint)).toBe(true);

    const raw = JSON.parse(
      readFileSync(join(home, "known_clients.json"), "utf8"),
    ) as { v: number; clients: Array<{ fingerprint: string }> };
    expect(raw.v).toBe(1);
    expect(raw.clients[0]?.fingerprint).toBe(client.fingerprint);
  });

  it("identity is stable across daemon restarts", () => {
    const home = resolveSidecodeHome();
    const id1 = loadOrCreateIdentity(home);
    const id2 = loadOrCreateIdentity(home);
    expect(id2.publicKeyB64).toBe(id1.publicKeyB64);
    expect(id2.fingerprint).toBe(id1.fingerprint);
  });

  it("known clients persist across simulated daemon restart", () => {
    // First boot: pair a client.
    const client = freshClient();
    {
      const home = resolveSidecodeHome();
      const identity = loadOrCreateIdentity(home);
      const known = KnownClients.load(home);
      const pairing = new PairingService(identity, known);
      const offer = pairing.createOffer("first-boot");
      const sessionId = `boot-${Date.now()}`;
      const hello = {
        type: "client.hello" as const,
        v: HANDSHAKE_VERSION,
        sessionId,
        mode: "qr_bootstrap" as const,
        clientFingerprint: client.fingerprint,
        clientIdentityPublicKey: client.publicKeyB64,
        clientNonce: randomBytes(32).toString("base64url"),
        offerExpiresAt: offer.expiresAt,
        offerDaemonFingerprint: offer.daemonFingerprint,
      };
      const helloRes = pairing.processClientHello(hello);
      if (!helloRes.ok) throw new Error("hello failed");
      const transcriptInput: TranscriptInput = {
        sessionId,
        protocolVersion: HANDSHAKE_VERSION,
        mode: "qr_bootstrap",
        keyEpoch: helloRes.serverHello.keyEpoch,
        daemonFingerprint: helloRes.serverHello.daemonFingerprint,
        clientFingerprint: client.fingerprint,
        daemonIdentityPublicKey: helloRes.serverHello.daemonIdentityPublicKey,
        clientIdentityPublicKey: client.publicKeyB64,
        clientNonce: hello.clientNonce,
        serverNonce: helloRes.serverHello.serverNonce,
        expiresAt: helloRes.serverHello.expiresAt,
      };
      const sig = cryptoSign(
        null,
        buildClientAuthTranscript(transcriptInput),
        client.privateKey,
      );
      expect(
        pairing.processClientAuth({
          type: "client.auth",
          v: HANDSHAKE_VERSION,
          sessionId,
          clientFingerprint: client.fingerprint,
          keyEpoch: helloRes.serverHello.keyEpoch,
          clientSignature: Buffer.from(sig).toString("base64url"),
        }).ok,
      ).toBe(true);
    }

    // Second boot — same home dir, identity reloads, paired client still there.
    {
      const home = resolveSidecodeHome();
      const known = KnownClients.load(home);
      expect(known.list()).toHaveLength(1);
      expect(known.has(client.fingerprint)).toBe(true);
    }
  });
});
