#!/usr/bin/env node
/**
 * P2.2 spike: verify node-datachannel's polyfill gives us a working
 * browser-shaped RTCPeerConnection on Node 24 + macOS arm64.
 *
 *   1. Create a PeerConnection with Cloudflare STUN configured.
 *   2. Open a DataChannel (so the SDP carries an m= line for SCTP).
 *   3. createOffer + setLocalDescription.
 *   4. Wait briefly for ICE host candidate gathering.
 *   5. Validate the resulting SDP contains:
 *        - a=fingerprint:sha-256 ...   (DTLS — E2EE root)
 *        - a=ice-ufrag                  (ICE credentials)
 *        - m=application ... DTLS/SCTP  (DataChannel transport line)
 *        - at least one candidate:      (ICE host candidate)
 *
 * Does NOT exchange the offer with anyone — that's P2.3.
 *
 * Run:
 *   node packages/daemon/scripts/webrtc-spike.mjs
 */
import { RTCPeerConnection } from "node-datachannel/polyfill";

const pc = new RTCPeerConnection({
  iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
});

const candidates = [];
pc.addEventListener("icecandidate", (e) => {
  if (e.candidate) candidates.push(e.candidate.candidate);
});

const dc = pc.createDataChannel("sidecode/v1", { ordered: true });
console.log(`DataChannel created, readyState: ${dc.readyState}`);

const offer = await pc.createOffer({});
await pc.setLocalDescription(offer);

// Wait for ICE gathering — node-datachannel's polyfill resolves
// candidates asynchronously even in the no-network case.
await new Promise((resolve) => {
  const check = () => {
    if (pc.iceGatheringState === "complete") resolve();
    else setTimeout(check, 50);
  };
  check();
});

const sdp = pc.localDescription?.sdp ?? "";

function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) process.exitCode = 1;
}

console.log("\nSDP checks:");
assert(
  sdp.includes("a=fingerprint:sha-256"),
  "DTLS fingerprint present (E2EE root)",
);
assert(sdp.includes("a=ice-ufrag:"), "ICE ufrag present");
assert(sdp.includes("a=ice-pwd:"), "ICE pwd present");
assert(
  /m=application \d+ .*DTLS\/SCTP/.test(sdp),
  "m=application DTLS/SCTP line present",
);
assert(
  candidates.length > 0,
  `at least one ICE candidate gathered (got ${candidates.length})`,
);

console.log("\nPeerConnection state:");
console.log(`  connectionState:    ${pc.connectionState}`);
console.log(`  iceConnectionState: ${pc.iceConnectionState}`);
console.log(`  iceGatheringState:  ${pc.iceGatheringState}`);
console.log(`  signalingState:     ${pc.signalingState}`);

console.log(`\nGathered ${candidates.length} ICE candidates (first 4):`);
for (const c of candidates.slice(0, 4)) console.log(`  ${c}`);

console.log("\nSDP fingerprint line(s):");
for (const line of sdp.split("\n")) {
  if (line.startsWith("a=fingerprint:")) console.log(`  ${line.trim()}`);
}

pc.close();
console.log(
  `\n${process.exitCode === 1 ? "✗ some checks failed" : "✓ all checks passed"}`,
);
process.exit(process.exitCode ?? 0);
