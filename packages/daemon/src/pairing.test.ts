import {
  createHash,
  sign as cryptoSign,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClientAuthTranscript,
  type ClientAuthFrame,
  type ClientHelloFrame,
  HANDSHAKE_VERSION,
  type HandshakeMode,
  type PairOfferFrame,
  type ServerHelloFrame,
  type TranscriptInput,
} from "@sidecodeapp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { OFFER_TTL_MS, PairingService } from "./pairing.js";

interface MockClient {
  publicKeyB64: string;
  privateKey: KeyObject;
  fingerprint: string;
}

function makeMockClient(): MockClient {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const fingerprint = createHash("sha256")
    .update(Buffer.from(jwk.x, "base64url"))
    .digest("hex")
    .slice(0, 16);
  return { publicKeyB64: jwk.x, privateKey, fingerprint };
}

/** Build a client.hello for qr_bootstrap, echoing the offer fields. */
function helloForOffer(
  client: MockClient,
  offer: PairOfferFrame,
): ClientHelloFrame {
  return {
    type: "client.hello",
    v: HANDSHAKE_VERSION,
    sessionId: randomUUID(),
    mode: "qr_bootstrap",
    clientFingerprint: client.fingerprint,
    clientIdentityPublicKey: client.publicKeyB64,
    clientNonce: randomBytes(32).toString("base64url"),
    offerExpiresAt: offer.expiresAt,
    offerDaemonFingerprint: offer.daemonFingerprint,
  };
}

/** Build a client.hello for trusted_reconnect (no offer-echo fields). */
function helloForReconnect(client: MockClient): ClientHelloFrame {
  return {
    type: "client.hello",
    v: HANDSHAKE_VERSION,
    sessionId: randomUUID(),
    mode: "trusted_reconnect",
    clientFingerprint: client.fingerprint,
    clientIdentityPublicKey: client.publicKeyB64,
    clientNonce: randomBytes(32).toString("base64url"),
  };
}

/** Build a client.hello with caller-controlled mode (used for malformed cases). */
function makeHello(
  client: MockClient,
  mode: HandshakeMode,
  extra: Partial<ClientHelloFrame> = {},
): ClientHelloFrame {
  return {
    type: "client.hello",
    v: HANDSHAKE_VERSION,
    sessionId: randomUUID(),
    mode,
    clientFingerprint: client.fingerprint,
    clientIdentityPublicKey: client.publicKeyB64,
    clientNonce: randomBytes(32).toString("base64url"),
    ...extra,
  };
}

function signClientAuth(
  serverHello: ServerHelloFrame,
  hello: ClientHelloFrame,
  client: MockClient,
): ClientAuthFrame {
  const transcriptInput: TranscriptInput = {
    sessionId: hello.sessionId,
    protocolVersion: HANDSHAKE_VERSION,
    mode: hello.mode,
    keyEpoch: serverHello.keyEpoch,
    daemonFingerprint: serverHello.daemonFingerprint,
    clientFingerprint: hello.clientFingerprint,
    daemonIdentityPublicKey: serverHello.daemonIdentityPublicKey,
    clientIdentityPublicKey: hello.clientIdentityPublicKey,
    clientNonce: hello.clientNonce,
    serverNonce: serverHello.serverNonce,
    expiresAt: serverHello.expiresAt,
  };
  const sig = cryptoSign(
    null,
    buildClientAuthTranscript(transcriptInput),
    client.privateKey,
  );
  return {
    type: "client.auth",
    v: HANDSHAKE_VERSION,
    sessionId: hello.sessionId,
    clientFingerprint: client.fingerprint,
    keyEpoch: serverHello.keyEpoch,
    clientSignature: Buffer.from(sig).toString("base64url"),
  };
}

describe("PairingService.createOffer", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-pair-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("returns a stateless offer with our identity", () => {
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known, {
      daemonAddress: "ws://10.0.0.1:41234",
    });
    const offer = pairing.createOffer("sidecode-test");
    expect(offer.type).toBe("pair.offer");
    expect(offer.daemonFingerprint).toBe(identity.fingerprint);
    expect(offer.daemonIdentityPublicKey).toBe(identity.publicKeyB64);
    expect(offer.daemonAddress).toBe("ws://10.0.0.1:41234");
    expect(offer.serviceName).toBe("sidecode-test");
    expect(offer.v).toBe(HANDSHAKE_VERSION);
    expect(offer.expiresAt).toBeGreaterThan(Date.now());
    // No sessionId on the offer in the new design.
    expect((offer as Record<string, unknown>).sessionId).toBeUndefined();
  });

  it("multiple offers from the same service return distinct expiresAt timestamps", () => {
    let now = 1_000_000;
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known, { clock: () => now });
    const a = pairing.createOffer("test");
    now += 1_000;
    const b = pairing.createOffer("test");
    expect(b.expiresAt).toBeGreaterThan(a.expiresAt);
  });
});

describe("PairingService — qr_bootstrap happy path", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-pair-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("completes hello → server.hello → auth → server.ready and persists client", () => {
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known);

    const offer = pairing.createOffer("test");
    const client = makeMockClient();
    const hello = helloForOffer(client, offer);
    const helloRes = pairing.processClientHello(hello);
    expect(helloRes.ok).toBe(true);
    if (!helloRes.ok) return;
    expect(helloRes.serverHello.daemonSignature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(helloRes.serverHello.expiresAt).toBe(offer.expiresAt);

    const auth = signClientAuth(helloRes.serverHello, hello, client);
    const authRes = pairing.processClientAuth(auth);
    expect(authRes.ok).toBe(true);
    if (!authRes.ok) return;
    expect(authRes.client.fingerprint).toBe(client.fingerprint);
    expect(authRes.ready.type).toBe("server.ready");

    expect(KnownClients.load(home).list()).toHaveLength(1);
  });

  it("two different clients can pair off the same offer", () => {
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known);
    const offer = pairing.createOffer("test");

    for (const client of [makeMockClient(), makeMockClient()]) {
      const hello = helloForOffer(client, offer);
      const helloRes = pairing.processClientHello(hello);
      expect(helloRes.ok).toBe(true);
      if (!helloRes.ok) return;
      const auth = signClientAuth(helloRes.serverHello, hello, client);
      expect(pairing.processClientAuth(auth).ok).toBe(true);
    }
    expect(KnownClients.load(home).list()).toHaveLength(2);
  });
});

describe("PairingService — qr_bootstrap failure modes", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-pair-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function bootstrap(opts: { now?: () => number; ttl?: number } = {}) {
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known, {
      clock: opts.now,
      offerTtlMs: opts.ttl,
    });
    return { identity, known, pairing };
  }

  it("rejects qr_bootstrap missing offerExpiresAt / offerDaemonFingerprint", () => {
    const { pairing } = bootstrap();
    const client = makeMockClient();
    const res = pairing.processClientHello(makeHello(client, "qr_bootstrap"));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reject.code).toBe("internal");
      expect(res.reject.message).toContain("offerDaemonFingerprint");
    }
  });

  it("rejects offer for a different daemon", () => {
    const { pairing } = bootstrap();
    const client = makeMockClient();
    const res = pairing.processClientHello(
      makeHello(client, "qr_bootstrap", {
        offerExpiresAt: Date.now() + 60_000,
        offerDaemonFingerprint: "0".repeat(16),
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reject.code).toBe("internal");
      expect(res.reject.message).toMatch(/different daemon/);
    }
  });

  it("rejects offer that has expired", () => {
    let now = 1_000_000;
    const { pairing, identity } = bootstrap({ now: () => now });
    const client = makeMockClient();
    const offerExpiresAt = now + 5_000;
    now += 6_000;
    const res = pairing.processClientHello(
      makeHello(client, "qr_bootstrap", {
        offerExpiresAt,
        offerDaemonFingerprint: identity.fingerprint,
      }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("session_expired");
  });

  it("rejects v mismatch", () => {
    const { pairing } = bootstrap();
    const offer = pairing.createOffer("test");
    const client = makeMockClient();
    const hello = helloForOffer(client, offer);
    hello.v = 999;
    const res = pairing.processClientHello(hello);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("version_mismatch");
  });

  it("rejects re-pair of an already-known client (qr_bootstrap)", () => {
    const { pairing } = bootstrap();
    const client = makeMockClient();

    // First pair.
    const firstOffer = pairing.createOffer("a");
    const firstHello = helloForOffer(client, firstOffer);
    const firstHelloRes = pairing.processClientHello(firstHello);
    expect(firstHelloRes.ok).toBe(true);
    if (!firstHelloRes.ok) return;
    const firstAuth = signClientAuth(
      firstHelloRes.serverHello,
      firstHello,
      client,
    );
    expect(pairing.processClientAuth(firstAuth).ok).toBe(true);

    // Second qr_bootstrap with same client — already paired, must reconnect instead.
    const secondOffer = pairing.createOffer("b");
    const res = pairing.processClientHello(helloForOffer(client, secondOffer));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("client_already_paired");
  });

  it("rejects bad client signature on auth", () => {
    const { pairing } = bootstrap();
    const offer = pairing.createOffer("test");
    const client = makeMockClient();
    const attacker = makeMockClient();
    const hello = helloForOffer(client, offer);
    const helloRes = pairing.processClientHello(hello);
    expect(helloRes.ok).toBe(true);
    if (!helloRes.ok) return;
    const auth = signClientAuth(helloRes.serverHello, hello, attacker);
    auth.clientFingerprint = client.fingerprint;
    const res = pairing.processClientAuth(auth);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("invalid_signature");
  });

  it("rejects fingerprint mismatch between hello and auth", () => {
    const { pairing } = bootstrap();
    const offer = pairing.createOffer("test");
    const client = makeMockClient();
    const hello = helloForOffer(client, offer);
    const helloRes = pairing.processClientHello(hello);
    expect(helloRes.ok).toBe(true);
    if (!helloRes.ok) return;
    const auth = signClientAuth(helloRes.serverHello, hello, client);
    auth.clientFingerprint = "x".repeat(16);
    const res = pairing.processClientAuth(auth);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("invalid_signature");
  });

  it("auth without prior hello → session_unknown", () => {
    const { pairing } = bootstrap();
    const res = pairing.processClientAuth({
      type: "client.auth",
      v: HANDSHAKE_VERSION,
      sessionId: "ghost",
      clientFingerprint: "x".repeat(16),
      keyEpoch: 1,
      clientSignature: "AAAA",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("session_unknown");
  });

  it("auth twice for same session → second consumed", () => {
    const { pairing } = bootstrap();
    const offer = pairing.createOffer("test");
    const client = makeMockClient();
    const hello = helloForOffer(client, offer);
    const helloRes = pairing.processClientHello(hello);
    if (!helloRes.ok) throw new Error("hello failed");
    const auth = signClientAuth(helloRes.serverHello, hello, client);
    expect(pairing.processClientAuth(auth).ok).toBe(true);
    const replay = pairing.processClientAuth(auth);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reject.code).toBe("session_unknown");
  });
});

describe("PairingService — trusted_reconnect", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-pair-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function bootstrapAndPair() {
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known);
    const client = makeMockClient();
    const offer = pairing.createOffer("test");
    const hello = helloForOffer(client, offer);
    const helloRes = pairing.processClientHello(hello);
    if (!helloRes.ok) throw new Error("initial pair hello failed");
    const auth = signClientAuth(helloRes.serverHello, hello, client);
    if (!pairing.processClientAuth(auth).ok)
      throw new Error("initial pair auth failed");
    return { pairing, identity, known, client };
  }

  it("known client can re-authenticate without QR", () => {
    const { pairing, client } = bootstrapAndPair();
    const hello = helloForReconnect(client);
    const helloRes = pairing.processClientHello(hello);
    expect(helloRes.ok).toBe(true);
    if (!helloRes.ok) return;
    const auth = signClientAuth(helloRes.serverHello, hello, client);
    expect(pairing.processClientAuth(auth).ok).toBe(true);
  });

  it("unknown fingerprint → client_unknown", () => {
    const { pairing } = bootstrapAndPair();
    const stranger = makeMockClient();
    const res = pairing.processClientHello(helloForReconnect(stranger));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("client_unknown");
  });

  it("known fingerprint but lying about pubkey → invalid_signature", () => {
    const { pairing, client } = bootstrapAndPair();
    const fake = makeMockClient();
    const hello = helloForReconnect(fake);
    hello.clientFingerprint = client.fingerprint;
    const res = pairing.processClientHello(hello);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("invalid_signature");
  });
});

describe("PairingService.prune", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-pair-"));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("drops stalled in-flight transcripts", () => {
    let now = 1_000_000;
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known, {
      clock: () => now,
      transcriptTtlMs: 1_000,
    });
    const offer = pairing.createOffer("test");
    const client = makeMockClient();
    const hello = helloForOffer(client, offer);
    const helloRes = pairing.processClientHello(hello);
    expect(helloRes.ok).toBe(true);

    now += 1_500; // exceed transcript TTL
    const result = pairing.prune();
    expect(result.transcripts).toBe(1);

    // Stale auth now fails because transcript pruned.
    if (!helloRes.ok) return;
    const auth = signClientAuth(helloRes.serverHello, hello, client);
    const res = pairing.processClientAuth(auth);
    expect(res.ok).toBe(false);
  });

  it("offer expiry needs no daemon-side pruning (offers are stateless)", () => {
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known, {
      offerTtlMs: OFFER_TTL_MS,
    });
    pairing.createOffer("a");
    pairing.createOffer("b");
    // No assertion about offer count — there's nothing to count anymore.
    expect(pairing.prune().transcripts).toBe(0);
  });
});
