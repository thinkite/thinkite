#!/usr/bin/env node
/**
 * P2.3 spike: daemon-side signaling orchestrator.
 *
 * Wires partysocket + node-datachannel together. Daemon:
 *   1. Connects to signaling as role=daemon (real Ed25519 identity).
 *   2. On `peer.joined` event, creates an RTCPeerConnection for that
 *      specific client (stored in activePCs map — multi-device ready).
 *   3. Creates a DataChannel + offer + setLocalDescription.
 *   4. Forwards SDP offer to the new client via signaling, addressed
 *      with `to: <clientId>`.
 *   5. Forwards every gathered ICE candidate the same way.
 *
 * To prove daemon's outgoing messages actually arrive correctly, the
 * same script spawns a passive mock client that:
 *   - Connects as role=client with an ephemeral keypair.
 *   - Logs everything signaling sends it.
 *   - Asserts the offer + ICE candidates arrive with `from` server-stamped
 *     to the daemon's connection id.
 *
 * Does NOT test the daemon-receives-answer path (that's P2.4).
 *
 * Run:
 *   node packages/daemon/scripts/p2-orchestrator-spike.mjs
 */
import { sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import { RTCPeerConnection } from "node-datachannel/polyfill";
import { WebSocket } from "partysocket";
import { resolveSidecodeHome } from "../dist/home.js";
import { loadOrCreateIdentity } from "../dist/identity.js";

const HOST = process.env.SIGNALING_HOST ?? "signaling.sidecode.app";
const SCHEME = process.env.SIGNALING_INSECURE === "1" ? "ws" : "wss";

const home = resolveSidecodeHome();
const daemon = loadOrCreateIdentity(home);
console.log(
  `daemon identity: ${daemon.fingerprint} (${daemon.publicKeyB64.slice(0, 12)}...)`,
);

// Generate an ephemeral mock-client keypair (we DON'T use daemon's identity
// for the client side — we want to simulate a separate iOS device).
const clientKp = generateKeyPairSync("ed25519");
const clientPubB64 = clientKp.publicKey.export({ format: "jwk" }).x;
console.log(`mock client pubkey: ${clientPubB64.slice(0, 12)}...`);

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

function buildDaemonUrl() {
  const ts = Date.now();
  const sig = cryptoSign(
    null,
    Buffer.from(`signaling/v1/${daemon.publicKeyB64}/${ts}`),
    daemon.privateKey,
  ).toString("base64url");
  const params = new URLSearchParams({ role: "daemon", ts: String(ts), sig });
  return `${SCHEME}://${HOST}/parties/signaling/${daemon.publicKeyB64}?${params}`;
}

function buildClientUrl() {
  const params = new URLSearchParams({ role: "client", pubkey: clientPubB64 });
  return `${SCHEME}://${HOST}/parties/signaling/${daemon.publicKeyB64}?${params}`;
}

function waitForOpen(ws, label) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    const onOpen = () => {
      ws.removeEventListener("open", onOpen);
      resolve();
    };
    ws.addEventListener("open", onOpen);
    setTimeout(() => reject(new Error(`${label}: open timeout`)), 5000);
  });
}

function waitFor(arr, pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = arr.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `${label}: timeout. saw types: ${arr.map((m) => m.type).join(",")}`,
          ),
        );
      }
      setTimeout(tick, 30);
    };
    tick();
  });
}

// === Daemon side ===
const activePCs = new Map();
const daemonMessages = [];
const daemonWS = new WebSocket(buildDaemonUrl, undefined, { maxRetries: 3 });
let daemonConnId = null;

daemonWS.addEventListener("message", async (e) => {
  const text =
    typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
  const msg = JSON.parse(text);
  daemonMessages.push(msg);

  if (msg.type === "peer.joined") {
    const clientId = msg.peer.id;
    console.log(
      `[daemon] peer.joined id=${clientId} pubkey=${msg.peer.pubkey.slice(0, 12)}...`,
    );

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });
    activePCs.set(clientId, pc);

    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        // Stringify candidate object — RTCIceCandidate's toJSON gives us
        // the parts the remote peer needs (candidate string + sdpMid +
        // sdpMLineIndex).
        const cand = event.candidate.toJSON
          ? event.candidate.toJSON()
          : { candidate: String(event.candidate) };
        daemonWS.send(
          JSON.stringify({ to: clientId, type: "candidate", candidate: cand }),
        );
      }
    });

    pc.createDataChannel("sidecode/v1", { ordered: true });
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    daemonWS.send(
      JSON.stringify({ to: clientId, type: "offer", sdp: offer.sdp }),
    );
    console.log(`[daemon] offer sent to ${clientId}`);
  }
});

await waitForOpen(daemonWS, "daemon");
// First message daemon receives is `peers` (initial roster); we can't
// easily read connection.id from outside, but we use it indirectly via
// the `from` field of forwarded messages later.
const initialPeers = await waitFor(
  daemonMessages,
  (m) => m.type === "peers",
  3000,
  "daemon peers",
);
console.log(
  `[daemon] initial peers: ${initialPeers.peers.length} client(s) already online`,
);

// === Mock client side ===
const clientMessages = [];
const clientWS = new WebSocket(buildClientUrl(), undefined, { maxRetries: 3 });
clientWS.addEventListener("message", (e) => {
  const text =
    typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
  clientMessages.push(JSON.parse(text));
});
await waitForOpen(clientWS, "client");
console.log("[client] connected");

// Client receives initial `peers` frame containing the daemon's id
const clientPeers = await waitFor(
  clientMessages,
  (m) => m.type === "peers",
  3000,
  "client peers",
);
const daemonPeerInfo = clientPeers.peers.find((p) => p.role === "daemon");
if (!daemonPeerInfo) {
  console.error("✗ client didn't see daemon in initial peers frame");
  process.exit(1);
}
daemonConnId = daemonPeerInfo.id;
console.log(`[client] sees daemon at id=${daemonConnId}`);

// === Wait for daemon to react to peer.joined and send us offer ===
const offer = await waitFor(
  clientMessages,
  (m) => m.type === "offer",
  5000,
  "client offer",
);

console.log("\nP2.3 assertions:");
assert(
  offer.from === daemonConnId,
  `offer.from matches daemon id (got "${offer.from}")`,
);
assert(
  typeof offer.sdp === "string" && offer.sdp.includes("a=fingerprint:sha-256"),
  "offer.sdp carries DTLS fingerprint",
);
assert(
  offer.sdp.includes("m=application"),
  "offer.sdp has DataChannel m=application line",
);
assert(offer.sdp.includes("a=ice-ufrag:"), "offer.sdp carries ICE ufrag");

// Wait a bit for ICE candidates to flow through
await new Promise((r) => setTimeout(r, 3000));
const candidates = clientMessages.filter((m) => m.type === "candidate");
console.log(
  `  ${candidates.length > 0 ? "✓" : "✗"} client received ${candidates.length} ICE candidates`,
);
if (candidates.length === 0) failures += 1;

// Sample a couple candidates to show they look right
for (const c of candidates.slice(0, 3)) {
  console.log(
    `    ${c.candidate?.candidate ?? JSON.stringify(c.candidate)?.slice(0, 80)}`,
  );
}

assert(
  activePCs.size === 1,
  `daemon tracks 1 active PC (got ${activePCs.size})`,
);

// Cleanup
for (const pc of activePCs.values()) pc.close();
daemonWS.close();
clientWS.close();
await new Promise((r) => setTimeout(r, 200));

console.log(
  `\n${failures === 0 ? "✓ all P2.3 checks passed" : `✗ ${failures} failures`}`,
);
process.exit(failures === 0 ? 0 : 1);
