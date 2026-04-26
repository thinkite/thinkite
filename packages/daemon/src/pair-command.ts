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

/**
 * Implementation of the `sidecode pair` subcommand.
 *
 * Day 2-equivalent: prints the base64url-encoded `pair.offer` JSON for manual
 * delivery to a mobile client. Day 3+ adds a WS handshake; this CLI command
 * stays as a power-user / SSH-friendly path.
 *
 * `--self-test` runs the full handshake (client.hello → server.hello →
 * client.auth → server.ready) in-process to validate the crypto stack
 * without any network.
 */
export async function runPairCommand(args: readonly string[]): Promise<void> {
  if (args.includes("--self-test")) {
    return runSelfTest();
  }

  const home = resolveSidecodeHome();
  const identity = loadOrCreateIdentity(home);
  const known = KnownClients.load(home);
  const pairing = new PairingService(identity, known);

  const { offer } = pairing.createOffer(`sidecode-${hostname()}`);
  const encoded = Buffer.from(JSON.stringify(offer)).toString("base64url");

  console.log("Pair payload (paste into mobile client to pair):");
  console.log("");
  console.log(encoded);
  console.log("");
  console.log(`SessionId:    ${offer.sessionId}`);
  console.log(`Fingerprint:  ${identity.fingerprint}`);
  console.log(`Address:      ${offer.daemonAddress}`);
  console.log(`Expires:      ${new Date(offer.expiresAt).toISOString()}`);
  console.log("");
  console.log(
    "Note: Day 2 has no WS server yet. To complete pair, run --self-test or",
  );
  console.log(
    "wait for Day 3 WS server. The mock client (scripts/mock-pair-client.ts)",
  );
  console.log("can produce a client.hello payload from this offer.");
}

/**
 * Self-test: runs the full handshake in-process and exits 0/1. Useful for CI
 * smoke testing of the crypto + persistence stack.
 */
async function runSelfTest(): Promise<void> {
  const home = resolveSidecodeHome();
  const identity = loadOrCreateIdentity(home);
  const known = KnownClients.load(home);
  const pairing = new PairingService(identity, known);

  console.log("=== sidecode pair --self-test ===");
  console.log(`home:        ${home}`);
  console.log(`fingerprint: ${identity.fingerprint}`);

  // Server-side: produce offer.
  const { offer, sessionId } = pairing.createOffer("self-test");
  console.log(`offer sessionId: ${sessionId}`);

  // Client-side: ephemeral keypair + compute fingerprint.
  const { publicKey: clientPub, privateKey: clientPriv } =
    generateKeyPairSync("ed25519");
  const clientPubB64 = (clientPub.export({ format: "jwk" }) as { x: string }).x;
  const clientFingerprint = createHash("sha256")
    .update(Buffer.from(clientPubB64, "base64url"))
    .digest("hex")
    .slice(0, 16);
  const clientNonce = randomBytes(32).toString("base64url");

  // client.hello → server.hello
  const hello = {
    type: "client.hello" as const,
    v: HANDSHAKE_VERSION,
    sessionId,
    mode: "qr_bootstrap" as const,
    clientFingerprint,
    clientIdentityPublicKey: clientPubB64,
    clientNonce,
  };
  const helloOutcome = pairing.processClientHello(hello);
  if (!helloOutcome.ok) {
    console.error(
      `✗ client.hello rejected: ${helloOutcome.reject.code} — ${helloOutcome.reject.message}`,
    );
    process.exit(1);
  }
  console.log(
    `→ server.hello signed (signature ${helloOutcome.serverHello.daemonSignature.slice(0, 16)}…)`,
  );

  // client.auth: sign (transcript || CLIENT_AUTH_LABEL).
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
