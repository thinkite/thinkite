#!/usr/bin/env node
import { createHash } from "node:crypto";
/**
 * P3.4 helper: run WebRTCPeerServer forever, pre-paired with a given
 * iOS client pubkey. Used for end-to-end testing of the iOS
 * SignalingClient + WebRTCPeer integration against a real daemon.
 *
 * Usage:
 *   node packages/daemon/scripts/run-paired-daemon.mjs <ios-pubkey-base64url>
 *
 * Stores known_clients + identity under a fresh tmpdir so it doesn't
 * pollute your real ~/.sidecode/. Prints the daemon's own pubkey on
 * startup — paste that into the iOS spike's "daemon pubkey" field.
 *
 * Ctrl-C to stop.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOrCreateIdentity } from "../dist/identity.js";
import { KnownClients } from "../dist/known-clients.js";
import { WebRTCPeerServer } from "../dist/webrtc-peer.js";

const iosPubkey = process.argv[2];
if (!iosPubkey) {
  console.error("usage: node run-paired-daemon.mjs <ios-pubkey-base64url>");
  process.exit(1);
}

// Fresh, throwaway home dir — keeps the test daemon's known_clients +
// identity isolated from your real ~/.sidecode/ install.
const testHome = mkdtempSync(join(tmpdir(), "sidecode-test-daemon-"));
console.log(`test home: ${testHome}`);

const identity = loadOrCreateIdentity(testHome);
const known = KnownClients.load(testHome);

const iosFingerprint = createHash("sha256")
  .update(Buffer.from(iosPubkey, "base64url"))
  .digest("hex")
  .slice(0, 16);
known.add({
  fingerprint: iosFingerprint,
  publicKeyB64: iosPubkey,
  pairedAt: Date.now(),
});

console.log("");
console.log("┌─────────────────────────────────────────────────────────");
console.log("│ DAEMON PUBKEY (paste into iOS spike):");
console.log(`│   ${identity.publicKeyB64}`);
console.log("├─────────────────────────────────────────────────────────");
console.log(
  `│ paired iOS client: ${iosFingerprint} (${iosPubkey.slice(0, 12)}…)`,
);
console.log("└─────────────────────────────────────────────────────────");
console.log("");

const server = new WebRTCPeerServer({
  identity,
  knownClients: known,
  log: (event, data) => {
    if (event === "signaling.peers") return; // noisy
    console.log(`[${event}]${data ? ` ${JSON.stringify(data)}` : ""}`);
  },
});

await server.start();
console.log("✓ daemon listening on signaling.sidecode.app — Ctrl-C to stop");

process.on("SIGINT", async () => {
  console.log("\nshutting down…");
  await server.stop();
  process.exit(0);
});
