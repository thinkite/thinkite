// Mock pair client — manual debugging companion to `sidecode pair`.
//
// Day 2-equivalent: produces the `client.hello` payload that a real iOS client
// would send first over WS. Day 3+ extends this to actually connect to the
// daemon's WS server, send the frames, and complete the handshake.
//
// Usage:
//   pnpm exec tsx scripts/mock-pair-client.ts <base64-pair-offer>

import {
  createHash,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import {
  HANDSHAKE_VERSION,
  pairOfferFrame,
} from "@sidecodeapp/protocol";

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

if (offer.v !== HANDSHAKE_VERSION) {
  console.error(
    `Offer protocol version ${offer.v} ≠ this client's ${HANDSHAKE_VERSION}.`,
  );
  console.error(
    "Update sidecode on the Mac or this client; they must match for the handshake to verify.",
  );
  process.exit(1);
}

if (Date.now() > offer.expiresAt) {
  console.error(
    `Offer already expired at ${new Date(offer.expiresAt).toISOString()}.`,
  );
  console.error("Run `sidecode pair` again to get a fresh offer.");
  process.exit(1);
}

console.log("Decoded offer:");
console.log(`  daemon fingerprint: ${offer.daemonFingerprint}`);
console.log(`  daemon address:     ${offer.daemonAddress}`);
console.log(`  service:            ${offer.serviceName}`);
console.log(`  sessionId:          ${offer.sessionId}`);
console.log(`  protocol version:   ${offer.v}`);
console.log(
  `  expires in:         ${Math.round((offer.expiresAt - Date.now()) / 1000)}s`,
);
console.log("");

// Generate ephemeral client keypair.
const { publicKey } = generateKeyPairSync("ed25519");
const jwk = publicKey.export({ format: "jwk" }) as { x: string };
const clientPubB64 = jwk.x;
const clientFingerprint = createHash("sha256")
  .update(Buffer.from(clientPubB64, "base64url"))
  .digest("hex")
  .slice(0, 16);
const clientNonce = randomBytes(32).toString("base64url");

const clientHello = {
  type: "client.hello" as const,
  v: HANDSHAKE_VERSION,
  sessionId: offer.sessionId,
  mode: "qr_bootstrap" as const,
  clientFingerprint,
  clientIdentityPublicKey: clientPubB64,
  clientNonce,
};

console.log("Generated client.hello (would be first WS frame after connect):");
console.log(`  client fingerprint: ${clientFingerprint}`);
console.log(`  client nonce:       ${clientNonce.slice(0, 16)}…`);
console.log("");
console.log("client.hello payload (base64url JSON):");
console.log("");
console.log(Buffer.from(JSON.stringify(clientHello)).toString("base64url"));
console.log("");
console.log(
  "(Day 3+: this script will open a WebSocket to offer.daemonAddress and",
);
console.log(
  "complete the full handshake. For now it just prints the first frame.)",
);
