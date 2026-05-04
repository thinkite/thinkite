// Mock pair client — companion to `sidecode pair`. Runs the real WS handshake
// against a daemon. Use this to validate the auth state machine end-to-end
// without an iOS app handy.
//
// Usage:
//   # First pair via QR offer (also persists the client keypair to a file)
//   pnpm exec tsx scripts/mock-pair-client.ts pair <base64-pair-offer> [--key=./mock-client.key]
//
//   # Reconnect using a previously persisted keypair (no QR needed)
//   pnpm exec tsx scripts/mock-pair-client.ts auth <ws://host:port> [--key=./mock-client.key]

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  buildClientAuthTranscript,
  type ClientHelloFrame,
  HANDSHAKE_VERSION,
  pairOfferFrame,
  type ServerHelloFrame,
  type TranscriptInput,
} from "@sidecodeapp/protocol";
import { WebSocket } from "ws";

interface MockKeyPair {
  publicKeyB64: string;
  fingerprint: string;
  privateKey: KeyObject;
  pem: string;
}

interface ConnectArgs {
  url: string;
  hello: ClientHelloFrame;
  keypair: MockKeyPair;
  successLabel: string;
}

const DEFAULT_KEY_PATH = "./mock-client.key";

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main(): Promise<void> {
  const [mode, arg, ...rest] = process.argv.slice(2);
  const keyArg = rest.find((a) => a.startsWith("--key="));
  const keyPath = keyArg ? keyArg.slice("--key=".length) : DEFAULT_KEY_PATH;

  if (mode === "pair") {
    if (!arg) usageAndExit();
    await runPair(arg, keyPath);
  } else if (mode === "auth") {
    if (!arg) usageAndExit();
    await runAuth(arg, keyPath);
  } else {
    usageAndExit();
  }
}

function usageAndExit(): never {
  console.error("usage:");
  console.error(
    "  tsx scripts/mock-pair-client.ts pair <base64-pair-offer> [--key=./mock-client.key]",
  );
  console.error(
    "  tsx scripts/mock-pair-client.ts auth <ws://host:port>     [--key=./mock-client.key]",
  );
  process.exit(1);
}

async function runPair(offerB64: string, keyPath: string): Promise<void> {
  const offer = decodeOffer(offerB64);
  if (offer.v !== HANDSHAKE_VERSION) {
    fatal(
      `offer v=${offer.v} != HANDSHAKE_VERSION=${HANDSHAKE_VERSION}; client out of date`,
    );
  }
  if (Date.now() > offer.expiresAt) {
    fatal(
      `offer already expired at ${new Date(offer.expiresAt).toISOString()}`,
    );
  }
  const keypair = generateOrLoadClientKeypair(keyPath);
  console.log(`mock client fingerprint: ${keypair.fingerprint}`);
  console.log(`daemon  fingerprint:     ${offer.daemonFingerprint}`);
  console.log(`daemon  address:         ${offer.daemonAddress}`);
  console.log(
    `offer expires:           ${new Date(offer.expiresAt).toISOString()}`,
  );

  const hello: ClientHelloFrame = {
    type: "client.hello",
    v: HANDSHAKE_VERSION,
    sessionId: randomUUID(),
    mode: "qr_bootstrap",
    clientFingerprint: keypair.fingerprint,
    clientIdentityPublicKey: keypair.publicKeyB64,
    clientNonce: randomBytes(32).toString("base64url"),
    offerExpiresAt: offer.expiresAt,
    offerDaemonFingerprint: offer.daemonFingerprint,
  };

  await runHandshake({
    url: offer.daemonAddress,
    hello,
    keypair,
    successLabel: "✓ paired (qr_bootstrap)",
  });
  console.log(`  keypair persisted to ${keyPath}`);
  console.log(
    "  next time, run with `auth <ws://host:port>` to reconnect without QR",
  );
}

async function runAuth(daemonUrl: string, keyPath: string): Promise<void> {
  if (!existsSync(keyPath)) {
    fatal(
      `no keypair at ${keyPath}; run 'pair' first to establish a paired identity`,
    );
  }
  const keypair = loadKeypair(keyPath);
  console.log(`mock client fingerprint: ${keypair.fingerprint}`);
  console.log(`daemon address:          ${daemonUrl}`);

  const hello: ClientHelloFrame = {
    type: "client.hello",
    v: HANDSHAKE_VERSION,
    sessionId: randomUUID(),
    mode: "trusted_reconnect",
    clientFingerprint: keypair.fingerprint,
    clientIdentityPublicKey: keypair.publicKeyB64,
    clientNonce: randomBytes(32).toString("base64url"),
  };

  await runHandshake({
    url: daemonUrl,
    hello,
    keypair,
    successLabel: "✓ reconnected (trusted_reconnect)",
  });
}

async function runHandshake(args: ConnectArgs): Promise<void> {
  const ws = new WebSocket(args.url);
  await waitOpen(ws);
  ws.send(JSON.stringify(args.hello));

  const serverHello = await waitFrame<ServerHelloFrame>(ws);
  if (serverHello.type !== "server.hello") {
    fatal(`expected server.hello, got ${serverHello.type}`);
  }
  if (serverHello.clientNonce !== args.hello.clientNonce) {
    fatal("server.hello did not echo our clientNonce — possible MITM");
  }

  const transcriptInput: TranscriptInput = {
    sessionId: args.hello.sessionId,
    protocolVersion: HANDSHAKE_VERSION,
    mode: args.hello.mode,
    keyEpoch: serverHello.keyEpoch,
    daemonFingerprint: serverHello.daemonFingerprint,
    clientFingerprint: args.hello.clientFingerprint,
    daemonIdentityPublicKey: serverHello.daemonIdentityPublicKey,
    clientIdentityPublicKey: args.hello.clientIdentityPublicKey,
    clientNonce: args.hello.clientNonce,
    serverNonce: serverHello.serverNonce,
    expiresAt: serverHello.expiresAt,
  };
  // (Optional but recommended) verify daemonSignature here. V0 skip — daemon's
  // pubkey is TOFU on first pair; subsequent reconnects re-establish with same
  // key. A real iOS client should verify this with stored daemonPubkey.

  const sig = cryptoSign(
    null,
    buildClientAuthTranscript(transcriptInput),
    args.keypair.privateKey,
  );
  ws.send(
    JSON.stringify({
      type: "client.auth",
      v: HANDSHAKE_VERSION,
      sessionId: args.hello.sessionId,
      clientFingerprint: args.keypair.fingerprint,
      keyEpoch: serverHello.keyEpoch,
      clientSignature: Buffer.from(sig).toString("base64url"),
    }),
  );

  const ready = await waitFrame<{ type: string; daemonFingerprint: string }>(
    ws,
  );
  if (ready.type !== "server.ready") {
    fatal(`handshake failed; received ${JSON.stringify(ready)}`);
  }
  console.log(args.successLabel);
  console.log(`  authenticated to daemon ${ready.daemonFingerprint}`);
  ws.close();
}

// ─── helpers ──────────────────────────────────────────────────────────────

function decodeOffer(b64: string): ReturnType<typeof pairOfferFrame.parse> {
  try {
    const json = Buffer.from(b64, "base64url").toString("utf8");
    return pairOfferFrame.parse(JSON.parse(json));
  } catch (err) {
    fatal(`could not decode pair.offer: ${(err as Error).message}`);
  }
}

function generateOrLoadClientKeypair(path: string): MockKeyPair {
  if (existsSync(path)) return loadKeypair(path);
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  writeFileSync(path, pem, { mode: 0o600 });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const fingerprint = createHash("sha256")
    .update(Buffer.from(jwk.x, "base64url"))
    .digest("hex")
    .slice(0, 16);
  return { publicKeyB64: jwk.x, fingerprint, privateKey, pem };
}

function loadKeypair(path: string): MockKeyPair {
  const pem = readFileSync(path, "utf8");
  const privateKey = createPrivateKey({ key: pem, format: "pem" });
  const pub = createPublicKey(privateKey);
  const jwk = pub.export({ format: "jwk" }) as { x: string };
  const fingerprint = createHash("sha256")
    .update(Buffer.from(jwk.x, "base64url"))
    .digest("hex")
    .slice(0, 16);
  return { publicKeyB64: jwk.x, fingerprint, privateKey, pem };
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitFrame<T>(ws: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as T);
      } catch (err) {
        reject(err);
      }
    });
    ws.once("close", (code) =>
      reject(new Error(`closed before frame: ${code}`)),
    );
    ws.once("error", reject);
  });
}

function fatal(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}
