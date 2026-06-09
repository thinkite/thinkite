#!/usr/bin/env node
/**
 * P2.1 spike: load daemon's Ed25519 identity, connect to signaling.sidecode.app
 * with role=daemon + signed query params, verify the worker responds with the
 * initial `peers` frame.
 *
 * Run (defaults to prod signaling worker):
 *   node packages/daemon/scripts/signaling-spike.mjs
 *
 * Run against local wrangler dev:
 *   SIGNALING_HOST=localhost:8787 SIGNALING_INSECURE=1 \
 *     node packages/daemon/scripts/signaling-spike.mjs
 *
 * Does NOT do WebRTC yet — just verifies the partysocket round-trip works
 * with the daemon's real Ed25519 keypair.
 */
import { sign as cryptoSign } from "node:crypto";
import { WebSocket } from "partysocket";
import { resolveSidecodeHome } from "../dist/home.js";
import { loadOrCreateIdentity } from "../dist/identity.js";

const home = resolveSidecodeHome();
const identity = loadOrCreateIdentity(home);
console.log(`identity loaded: fingerprint=${identity.fingerprint}`);
console.log(`pubkey (base64url, 43 chars): ${identity.publicKeyB64}`);

const host = process.env.SIGNALING_HOST ?? "signaling.sidecode.app";
const insecure = process.env.SIGNALING_INSECURE === "1";
const scheme = insecure ? "ws" : "wss";

// PartySocket URL provider — runs on every connect / reconnect, so each
// attempt gets a fresh ts well inside the worker's ±60s skew window.
function buildUrl() {
  const ts = Date.now();
  const message = Buffer.from(`signaling/v1/${identity.publicKeyB64}/${ts}`);
  const sig = cryptoSign(null, message, identity.privateKey).toString(
    "base64url",
  );
  const params = new URLSearchParams({ role: "daemon", ts: String(ts), sig });
  return `${scheme}://${host}/parties/signaling/${identity.publicKeyB64}?${params}`;
}

const ws = new WebSocket(buildUrl, undefined, {
  maxRetries: 3,
});

const start = Date.now();
ws.addEventListener("open", () => {
  console.log(`[+${Date.now() - start}ms] open`);
});
ws.addEventListener("message", (e) => {
  const text =
    typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
  console.log(`[+${Date.now() - start}ms] recv:`, text);
});
ws.addEventListener("close", (e) => {
  console.log(
    `[+${Date.now() - start}ms] close: code=${e.code} reason=${e.reason}`,
  );
});
ws.addEventListener("error", (e) => {
  console.log(`[+${Date.now() - start}ms] error:`, e?.message ?? e);
});

// Exit after 5s — long enough to see the initial peers frame.
setTimeout(() => {
  console.log("\ndone, closing");
  ws.close();
  process.exit(0);
}, 5000);
