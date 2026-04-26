import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
} from "node:crypto";
import { hostname } from "node:os";
import {
  buildClientAuthTranscript,
  HANDSHAKE_VERSION,
  type TranscriptInput,
} from "@sidecodeapp/protocol";
import { resolveSidecodeHome } from "./home.js";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { PairingService } from "./pairing.js";
import { DEFAULT_PORT, WebSocketServer } from "./ws-server.js";

/**
 * Lifetime of an interactive `sidecode pair` session — how long the daemon
 * waits for the first client to complete the handshake.
 */
const PAIR_TIMEOUT_MS = 60_000;

/**
 * Implementation of the `sidecode pair` subcommand.
 *
 * Runs an ephemeral WS server, generates one pair.offer, prints it,
 * and waits up to 60s for the first client to complete the handshake.
 *
 * V0 model: `sidecode pair` is one-shot (run when adding a new client).
 * `sidecode up` is the long-running daemon (already-paired clients reach
 * it via trusted_reconnect). The menu bar app (W3-W4) will eventually
 * make this seamless by keeping the daemon up and issuing offers on demand.
 *
 * `--self-test` runs the handshake in-process without a network — useful
 * for CI / smoke testing.
 *
 * `--port <n>` overrides the default WS port.
 */
export async function runPairCommand(args: readonly string[]): Promise<void> {
  if (args.includes("--self-test")) return runSelfTest();

  const port = parsePort(args) ?? DEFAULT_PORT;
  const home = resolveSidecodeHome();
  const identity = loadOrCreateIdentity(home);
  const knownClients = KnownClients.load(home);

  // Build PairingService + WS server in this process, sharing the instance
  // so the offer's sessionId is recognized when the client connects.
  const pairing = new PairingService(identity, knownClients, {
    daemonAddress: `ws://127.0.0.1:${port}`,
  });
  const ws = new WebSocketServer({
    pairing,
    port,
    host: "0.0.0.0",
    log: () => undefined, // silent stdout during pair
  });
  const bound = await ws.start();

  // Generate the offer AFTER the server bound, so we know the real port if 0.
  const { offer } = pairing.createOffer(`sidecode-${hostname()}`);
  const offerWithRealAddress = {
    ...offer,
    daemonAddress: `ws://${bound.host === "0.0.0.0" ? "127.0.0.1" : bound.host}:${bound.port}`,
  };
  const encoded = Buffer.from(JSON.stringify(offerWithRealAddress)).toString(
    "base64url",
  );

  console.log("Pair payload (paste into mobile client to pair):");
  console.log("");
  console.log(encoded);
  console.log("");
  console.log(`SessionId:    ${offer.sessionId}`);
  console.log(`Fingerprint:  ${identity.fingerprint}`);
  console.log(`Address:      ${offerWithRealAddress.daemonAddress}`);
  console.log(`Expires:      ${new Date(offer.expiresAt).toISOString()}`);
  console.log("");
  console.log("Waiting for client to complete handshake (up to 60s)…");
  console.log("");

  const result = await waitForFirstAuth(ws, PAIR_TIMEOUT_MS);
  await ws.stop();

  if (result === "timeout") {
    console.error("✗ pair timed out — no client completed the handshake.");
    process.exit(1);
  }
  console.log("✓ paired (1 client now authenticated)");
  console.log(`  total paired clients: ${KnownClients.load(home).list().length}`);
}

function parsePort(args: readonly string[]): number | undefined {
  const i = args.indexOf("--port");
  if (i === -1) return undefined;
  const value = args[i + 1];
  const port = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(port)) {
    throw new Error(`invalid --port value: ${value}`);
  }
  return port;
}

async function waitForFirstAuth(
  ws: WebSocketServer,
  timeoutMs: number,
): Promise<"ok" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  // Use the monotonic counter so a quickly-disconnecting client still counts.
  while (Date.now() < deadline) {
    if (ws.totalAuthenticatedCount() > 0) return "ok";
    await new Promise((r) => setTimeout(r, 200));
  }
  return "timeout";
}

/** Self-test: run the full handshake in-process. No WS, no network. */
async function runSelfTest(): Promise<void> {
  const home = resolveSidecodeHome();
  const identity = loadOrCreateIdentity(home);
  const known = KnownClients.load(home);
  const pairing = new PairingService(identity, known);

  console.log("=== sidecode pair --self-test ===");
  console.log(`home:        ${home}`);
  console.log(`fingerprint: ${identity.fingerprint}`);

  const { sessionId } = pairing.createOffer("self-test");
  console.log(`offer sessionId: ${sessionId}`);

  const { publicKey: clientPub, privateKey: clientPriv } =
    generateKeyPairSync("ed25519");
  const clientPubB64 = (clientPub.export({ format: "jwk" }) as { x: string }).x;
  const clientFingerprint = createHash("sha256")
    .update(Buffer.from(clientPubB64, "base64url"))
    .digest("hex")
    .slice(0, 16);
  const clientNonce = randomBytes(32).toString("base64url");

  const helloOutcome = pairing.processClientHello({
    type: "client.hello",
    v: HANDSHAKE_VERSION,
    sessionId,
    mode: "qr_bootstrap",
    clientFingerprint,
    clientIdentityPublicKey: clientPubB64,
    clientNonce,
  });
  if (!helloOutcome.ok) {
    console.error(
      `✗ client.hello rejected: ${helloOutcome.reject.code} — ${helloOutcome.reject.message}`,
    );
    process.exit(1);
  }
  console.log(
    `→ server.hello signed (signature ${helloOutcome.serverHello.daemonSignature.slice(0, 16)}…)`,
  );

  const transcriptInput: TranscriptInput = {
    sessionId,
    protocolVersion: HANDSHAKE_VERSION,
    mode: "qr_bootstrap",
    keyEpoch: helloOutcome.serverHello.keyEpoch,
    daemonFingerprint: helloOutcome.serverHello.daemonFingerprint,
    clientFingerprint,
    daemonIdentityPublicKey: helloOutcome.serverHello.daemonIdentityPublicKey,
    clientIdentityPublicKey: clientPubB64,
    clientNonce,
    serverNonce: helloOutcome.serverHello.serverNonce,
    expiresAt: helloOutcome.serverHello.expiresAt,
  };
  const sig = cryptoSign(
    null,
    buildClientAuthTranscript(transcriptInput),
    clientPriv,
  );
  const authOutcome = pairing.processClientAuth({
    type: "client.auth",
    v: HANDSHAKE_VERSION,
    sessionId,
    clientFingerprint,
    keyEpoch: helloOutcome.serverHello.keyEpoch,
    clientSignature: Buffer.from(sig).toString("base64url"),
  });
  if (!authOutcome.ok) {
    console.error(
      `✗ client.auth rejected: ${authOutcome.reject.code} — ${authOutcome.reject.message}`,
    );
    process.exit(1);
  }
  console.log(
    `✓ pair accepted: client fingerprint ${authOutcome.client.fingerprint}`,
  );
  console.log(`  (writes a real entry into ${home}/known_clients.json)`);
}
