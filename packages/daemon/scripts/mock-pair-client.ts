// Mock pair client — manual debugging companion to `sidecode pair`.
//
// Day 2 has no WS server, so this script's job is purely to validate the
// crypto round-trip:
//   1. Run `sidecode pair` to produce a base64 offer payload
//   2. Pass that payload as argv[2] to this script
//   3. Script generates an ephemeral keypair, signs the challenge correctly,
//      and prints the corresponding pair.proof payload
//   4. Verify the proof shape is well-formed
//
// In Day 3+, a future version of this script will connect to the WS server
// and complete the actual handshake instead of just printing the proof.
//
// Usage:
//   pnpm exec tsx scripts/mock-pair-client.ts <base64-offer>

import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { pairOfferFrame } from "@sidecodeapp/protocol";

const offerB64 = process.argv[2];
if (!offerB64) {
  console.error("usage: tsx scripts/mock-pair-client.ts <base64-pair-offer>");
  process.exit(1);
}

let offer: ReturnType<typeof pairOfferFrame.parse>;
try {
  const json = Buffer.from(offerB64, "base64url").toString("utf8");
  offer = pairOfferFrame.parse(JSON.parse(json));
} catch (err) {
  console.error("Failed to decode pair.offer payload:", (err as Error).message);
  process.exit(1);
}

if (Date.now() > offer.challengeExpiresAt) {
  console.error(
    `Challenge already expired at ${new Date(offer.challengeExpiresAt).toISOString()}.`,
  );
  console.error("Run `sidecode pair` again to get a fresh challenge.");
  process.exit(1);
}

console.log("Decoded offer:");
console.log(`  daemon fingerprint: ${offer.fingerprint}`);
console.log(`  service:            ${offer.serviceName}`);
console.log(`  protocol version:   ${offer.v}`);
console.log(
  `  expires in:         ${Math.round((offer.challengeExpiresAt - Date.now()) / 1000)}s`,
);
console.log("");

// Generate ephemeral client keypair.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" }) as { x: string };

// Sign hash(challenge || clientPubkey).
const challengeBytes = Buffer.from(offer.challenge, "base64url");
const clientPubBytes = Buffer.from(jwk.x, "base64url");
const hash = createHash("sha256")
  .update(challengeBytes)
  .update(clientPubBytes)
  .digest();
const signatureBytes = cryptoSign(null, hash, privateKey);

const proof = {
  type: "pair.proof" as const,
  clientPubkey: jwk.x,
  signature: Buffer.from(signatureBytes).toString("base64url"),
};

const clientFp = createHash("sha256")
  .update(clientPubBytes)
  .digest("hex")
  .slice(0, 16);

console.log("Generated proof:");
console.log(`  client fingerprint: ${clientFp}`);
console.log("");
console.log("Pair proof payload (base64url JSON):");
console.log("");
console.log(Buffer.from(JSON.stringify(proof)).toString("base64url"));
console.log("");
console.log(
  "(Day 3+: this script will send the proof over WS instead of printing it.)",
);
