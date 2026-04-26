import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign as cryptoSign,
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

function makeHello(
  client: MockClient,
  sessionId: string,
  mode: HandshakeMode,
): ClientHelloFrame {
  return {
    type: "client.hello",
    v: HANDSHAKE_VERSION,
    sessionId,
    mode,
    clientFingerprint: client.fingerprint,
    clientIdentityPublicKey: client.publicKeyB64,
    clientNonce: randomBytes(32).toString("base64url"),
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

  it("returns a well-formed offer with our identity", () => {
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known, {
      daemonAddress: "ws://10.0.0.1:41234",
    });
    const { offer, sessionId } = pairing.createOffer("sidecode-test");
    expect(offer.type).toBe("pair.offer");
    expect(offer.daemonFingerprint).toBe(identity.fingerprint);
    expect(offer.daemonIdentityPublicKey).toBe(identity.publicKeyB64);
    expect(offer.daemonAddress).toBe("ws://10.0.0.1:41234");
    expect(offer.serviceName).toBe("sidecode-test");
    expect(offer.sessionId).toBe(sessionId);
    expect(offer.v).toBe(HANDSHAKE_VERSION);
    expect(offer.expiresAt).toBeGreaterThan(Date.now());
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

    const { offer, sessionId } = pairing.createOffer("test");
    const client = makeMockClient();
    const hello = makeHello(client, sessionId, "qr_bootstrap");
    const helloRes = pairing.processClientHello(hello);
    expect(helloRes.ok).toBe(true);
    if (!helloRes.ok) return;
    expect(helloRes.serverHello.daemonSignature).toMatch(/^[A-Za-z0-9_-]+$/);

    const auth = signClientAuth(helloRes.serverHello, hello, client);
    const authRes = pairing.processClientAuth(auth);
    expect(authRes.ok).toBe(true);
    if (!authRes.ok) return;
    expect(authRes.client.fingerprint).toBe(client.fingerprint);
    expect(authRes.ready.type).toBe("server.ready");

    expect(KnownClients.load(home).list()).toHaveLength(1);
    expect(offer.sessionId).toBe(sessionId);
  });
});

describe("PairingService — failure modes", () => {
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

  it("rejects unknown sessionId on qr_bootstrap", () => {
    const { pairing } = bootstrap();
    const client = makeMockClient();
    const res = pairing.processClientHello(
      makeHello(client, "no-such-id", "qr_bootstrap"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("session_unknown");
  });

  it("rejects expired offer", () => {
    let now = 1_000_000;
    const { pairing } = bootstrap({ now: () => now });
    const { sessionId } = pairing.createOffer("test");
    now += OFFER_TTL_MS + 1;
    const client = makeMockClient();
    const res = pairing.processClientHello(
      makeHello(client, sessionId, "qr_bootstrap"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("session_expired");
  });

  it("rejects v mismatch", () => {
    const { pairing } = bootstrap();
    const { sessionId } = pairing.createOffer("test");
    const client = makeMockClient();
    const hello = makeHello(client, sessionId, "qr_bootstrap");
    hello.v = 999;
    const res = pairing.processClientHello(hello);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("version_mismatch");
  });

  it("rejects re-pair of an already-known client (qr_bootstrap)", () => {
    const { pairing } = bootstrap();
    const client = makeMockClient();

    // First pair: hello + auth must use the SAME hello (same clientNonce),
    // otherwise transcripts differ and signature verification fails.
    const first = pairing.createOffer("a");
    const firstHello = makeHello(client, first.sessionId, "qr_bootstrap");
    const firstHelloRes = pairing.processClientHello(firstHello);
    expect(firstHelloRes.ok).toBe(true);
    if (!firstHelloRes.ok) return;
    const firstAuth = signClientAuth(firstHelloRes.serverHello, firstHello, client);
    expect(pairing.processClientAuth(firstAuth).ok).toBe(true);

    // Second qr_bootstrap with same client → already paired
    const second = pairing.createOffer("b");
    const res = pairing.processClientHello(
      makeHello(client, second.sessionId, "qr_bootstrap"),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("client_already_paired");
  });

  it("rejects bad client signature on auth", () => {
    const { pairing } = bootstrap();
    const { sessionId } = pairing.createOffer("test");
    const client = makeMockClient();
    const attacker = makeMockClient();
    const hello = makeHello(client, sessionId, "qr_bootstrap");
    const helloRes = pairing.processClientHello(hello);
    expect(helloRes.ok).toBe(true);
    if (!helloRes.ok) return;
    // Sign with attacker's key but claim honest fingerprint
    const auth = signClientAuth(helloRes.serverHello, hello, attacker);
    auth.clientFingerprint = client.fingerprint; // claim wrong identity
    const res = pairing.processClientAuth(auth);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("invalid_signature");
  });

  it("rejects fingerprint mismatch between hello and auth", () => {
    const { pairing } = bootstrap();
    const { sessionId } = pairing.createOffer("test");
    const client = makeMockClient();
    const hello = makeHello(client, sessionId, "qr_bootstrap");
    const helloRes = pairing.processClientHello(hello);
    expect(helloRes.ok).toBe(true);
    if (!helloRes.ok) return;
    const auth = signClientAuth(helloRes.serverHello, hello, client);
    auth.clientFingerprint = "x".repeat(16); // different fp
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
    const { sessionId } = pairing.createOffer("test");
    const client = makeMockClient();
    const hello = makeHello(client, sessionId, "qr_bootstrap");
    const helloRes = pairing.processClientHello(hello);
    if (!helloRes.ok) throw new Error("hello failed");
    const auth = signClientAuth(helloRes.serverHello, hello, client);
    expect(pairing.processClientAuth(auth).ok).toBe(true);
    const replay = pairing.processClientAuth(auth);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reject.code).toBe("session_unknown");
  });

  it("two clients racing on the same sessionId — only one wins", () => {
    const { pairing } = bootstrap();
    const { sessionId } = pairing.createOffer("test");
    const a = makeMockClient();
    const b = makeMockClient();
    const helloA = pairing.processClientHello(
      makeHello(a, sessionId, "qr_bootstrap"),
    );
    expect(helloA.ok).toBe(true);
    const helloB = pairing.processClientHello(
      makeHello(b, sessionId, "qr_bootstrap"),
    );
    expect(helloB.ok).toBe(false);
    if (!helloB.ok) expect(helloB.reject.code).toBe("session_unknown");
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
    const { sessionId } = pairing.createOffer("test");
    const hello = makeHello(client, sessionId, "qr_bootstrap");
    const helloRes = pairing.processClientHello(hello);
    if (!helloRes.ok) throw new Error("initial pair hello failed");
    const auth = signClientAuth(helloRes.serverHello, hello, client);
    if (!pairing.processClientAuth(auth).ok)
      throw new Error("initial pair auth failed");
    return { pairing, identity, known, client };
  }

  it("known client can re-authenticate without QR", () => {
    const { pairing, client } = bootstrapAndPair();
    const hello = makeHello(client, "reconnect-1", "trusted_reconnect");
    const helloRes = pairing.processClientHello(hello);
    expect(helloRes.ok).toBe(true);
    if (!helloRes.ok) return;
    const auth = signClientAuth(helloRes.serverHello, hello, client);
    expect(pairing.processClientAuth(auth).ok).toBe(true);
  });

  it("unknown fingerprint → client_unknown", () => {
    const { pairing } = bootstrapAndPair();
    const stranger = makeMockClient();
    const hello = makeHello(stranger, "reconnect-x", "trusted_reconnect");
    const res = pairing.processClientHello(hello);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reject.code).toBe("client_unknown");
  });

  it("known fingerprint but lying about pubkey → invalid_signature", () => {
    const { pairing, client } = bootstrapAndPair();
    const fake = makeMockClient();
    const hello = makeHello(fake, "reconnect-y", "trusted_reconnect");
    hello.clientFingerprint = client.fingerprint; // claim known fp
    // pubkey is `fake`'s, which doesn't match stored
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

  it("drops expired offers and stalled transcripts", () => {
    let now = 1_000_000;
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    const pairing = new PairingService(identity, known, { clock: () => now });
    pairing.createOffer("a");
    pairing.createOffer("b");
    now += OFFER_TTL_MS + 1;
    const result = pairing.prune();
    expect(result.offers).toBe(2);
  });
});
