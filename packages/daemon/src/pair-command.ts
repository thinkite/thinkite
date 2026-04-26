import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
} from "node:crypto";
import { hostname } from "node:os";
import { resolveSidecodeHome } from "./home.js";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { PairingService } from "./pairing.js";

/**
 * Implementation of the `sidecode pair` subcommand.
 *
 * V0 has no WS server yet (Day 3), so this command:
 *   - prints the pair.offer payload as base64-encoded JSON for manual relay
 *     to a mobile client (or to scripts/mock-pair-client.ts)
 *   - or, with --self-test, runs the full pair round-trip in-process to
 *     prove the implementation end-to-end without any network
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
  console.log(`Fingerprint:  ${identity.fingerprint}`);
  console.log(`Expires:      ${new Date(offer.challengeExpiresAt).toISOString()}`);
  console.log("");
  console.log(
    "Note: Day 2 has no WS server yet. To complete pair, pipe the proof");
  console.log(
    "back into a future `sidecode pair-verify` (Day 3+) or use --self-test.",
  );
}

/**
 * Self-test: runs server's createOffer, mock client signs it, server verifies.
 * Exits 0 on success, 1 on any failure. Useful for CI / smoke testing the
 * crypto + persistence stack without launching a real client.
 */
async function runSelfTest(): Promise<void> {
  const home = resolveSidecodeHome();
  const identity = loadOrCreateIdentity(home);
  const known = KnownClients.load(home);
  const pairing = new PairingService(identity, known);

  console.log("=== sidecode pair --self-test ===");
  console.log(`home:        ${home}`);
  console.log(`fingerprint: ${identity.fingerprint}`);

  // Server side: generate offer.
  const { offer, challenge } = pairing.createOffer("self-test");
  console.log(`offer challenge: ${offer.challenge.slice(0, 16)}…`);

  // Client side: ephemeral keypair + sign hash(challenge || clientPub).
  const { publicKey: clientPub, privateKey: clientPriv } =
    generateKeyPairSync("ed25519");
  const jwk = clientPub.export({ format: "jwk" }) as { x: string };
  const challengeBytes = Buffer.from(offer.challenge, "base64url");
  const clientPubBytes = Buffer.from(jwk.x, "base64url");
  const hash = createHash("sha256")
    .update(challengeBytes)
    .update(clientPubBytes)
    .digest();
  const signature = cryptoSign(null, hash, clientPriv);
  const proof = {
    type: "pair.proof" as const,
    clientPubkey: jwk.x,
    signature: Buffer.from(signature).toString("base64url"),
  };

  // Server side: verify.
  const result = pairing.verifyProof(challenge, proof);

  if (result.ok) {
    console.log(`✓ pair accepted: client fingerprint ${result.accepted.clientFingerprint}`);
    console.log(`  (note: this writes a real entry into ${home}/known_clients.json)`);
  } else {
    console.error(`✗ pair rejected: ${result.rejected.reason}`);
    process.exit(1);
  }
}
