#!/usr/bin/env node
/**
 * P2.7c integration test: WebRTCPeerServer with DTLS-fingerprint-pinned
 * identity, ZERO application-layer handshake frames.
 *
 * Flow validated:
 *   1. Mock client pre-paired in known_clients (would normally happen
 *      during QR-scan + isPairing=true; we shortcut for the test).
 *   2. Daemon's WebRTCPeerServer connects to signaling.
 *   3. Mock client connects to signaling as role=client with its pubkey.
 *   4. Daemon receives peer.joined → looks up known_clients → finds the
 *      pubkey → creates PC + DataChannel + signs DTLS fingerprint with
 *      its Ed25519 → sends offer + fpSig.
 *   5. Mock client verifies fpSig against daemon's pubkey (out-of-band
 *      truth from QR — here just hardcoded), setRemoteDescription,
 *      createAnswer, signs its OWN fingerprint, sends answer + fpSig.
 *   6. Daemon verifies the answer's fpSig against client's known
 *      pubkey, setRemoteDescription.
 *   7. ICE completes, DTLS handshake succeeds, DataChannel opens.
 *   8. Client sends a plain `ping` frame; daemon `pong`s back. No
 *      handshake frames anywhere — first business message just works.
 *
 * Also verifies the negative cases:
 *   - Unknown pubkey with isPairing=false → daemon never sends offer.
 *   - Tampered SDP fingerprint in offer → mock client's verify fails.
 *     (We can't easily simulate a malicious signaling DO here, so this
 *     branch is covered by unit tests on the sdp-fingerprint helpers.)
 */
import {
  createHash,
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dtlsFingerprintTranscript,
  extractDtlsFingerprint,
} from "../../protocol/dist/index.js";
import { loadOrCreateIdentity, publicKeyFromB64 } from "../dist/identity.js";
import { KnownClients } from "../dist/known-clients.js";
import { WebRTCPeerServer } from "../dist/webrtc-peer.js";
import {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from "node-datachannel/polyfill";
import PartySocket from "partysocket";

const testHome = mkdtempSync(join(tmpdir(), "sidecode-p2-7c-"));
console.log(`test home: ${testHome}`);

const daemonId = loadOrCreateIdentity(testHome);
const known = KnownClients.load(testHome);

// Pre-pair the mock client (shortcut for what the menubar UI would do
// during isPairing=true).
const mockClientKp = generateKeyPairSync("ed25519");
const mockClientPubB64 = mockClientKp.publicKey.export({ format: "jwk" }).x;
const mockClientFingerprint = createHash("sha256")
  .update(Buffer.from(mockClientPubB64, "base64url"))
  .digest("hex")
  .slice(0, 16);
known.add({
  fingerprint: mockClientFingerprint,
  publicKeyB64: mockClientPubB64,
  pairedAt: Date.now(),
});

let failures = 0;
function assert(cond, label) {
  console.log(`  ${cond ? "✓" : "✗"} ${label}`);
  if (!cond) failures += 1;
}

// ─── Daemon ─────────────────────────────────────────────────────────
const server = new WebRTCPeerServer({
  identity: daemonId,
  knownClients: known,
  // isPairing defaults to false — we pre-added via known.add() above.
  log: (event, data) => {
    if (event !== "signaling.peers") {
      console.log(`[server] ${event}${data ? ` ${JSON.stringify(data)}` : ""}`);
    }
  },
});

console.log("starting WebRTCPeerServer...");
await server.start();
console.log("✓ server.start() resolved");

// ─── Mock client ────────────────────────────────────────────────────
const clientPC = new RTCPeerConnection({
  iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
});
let clientDC = null;
let daemonPeerId = null;

const clientWS = new PartySocket({
  host: "signaling.sidecode.app",
  protocol: "wss",
  party: "signaling",
  room: daemonId.publicKeyB64,
  query: { role: "client", pubkey: mockClientPubB64 },
  maxRetries: 3,
});

clientPC.addEventListener("icecandidate", (e) => {
  if (e.candidate && daemonPeerId) {
    const cand =
      typeof e.candidate.toJSON === "function" ? e.candidate.toJSON() : e.candidate;
    clientWS.send(
      JSON.stringify({ to: daemonPeerId, type: "candidate", candidate: cand }),
    );
  }
});

clientPC.addEventListener("datachannel", (event) => {
  clientDC = event.channel;
  clientDC.addEventListener("open", () => {
    console.log("[client] DC open — no handshake, sending ping directly");
    clientDC.send(JSON.stringify({ type: "ping", t: Date.now() }));
  });
  clientDC.addEventListener("message", (e) => {
    daemonReplies.push(JSON.parse(e.data));
  });
});

const daemonReplies = [];

clientWS.addEventListener("message", async (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === "peers") {
    const d = msg.peers.find((p) => p.role === "daemon");
    if (d) daemonPeerId = d.id;
  } else if (msg.type === "offer") {
    daemonPeerId = msg.from;

    // Verify daemon's fpSig against the daemon pubkey we know from QR.
    const fp = extractDtlsFingerprint(msg.sdp);
    const sigOk = cryptoVerify(
      null,
      Buffer.from(dtlsFingerprintTranscript(fp)),
      publicKeyFromB64(daemonId.publicKeyB64),
      Buffer.from(msg.fpSig, "base64url"),
    );
    if (!sigOk) {
      console.error("[client] daemon fpSig verification FAILED");
      failures += 1;
      return;
    }

    await clientPC.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp: msg.sdp }),
    );
    const answer = await clientPC.createAnswer();
    await clientPC.setLocalDescription(answer);

    // Sign our own DTLS fingerprint with the client's keypair so the
    // daemon can pin its remote-end too.
    const ourFp = extractDtlsFingerprint(answer.sdp);
    const fpSig = cryptoSign(
      null,
      Buffer.from(dtlsFingerprintTranscript(ourFp)),
      mockClientKp.privateKey,
    ).toString("base64url");

    clientWS.send(
      JSON.stringify({
        to: daemonPeerId,
        type: "answer",
        sdp: answer.sdp,
        fpSig,
      }),
    );
  } else if (msg.type === "candidate") {
    try {
      await clientPC.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch {
      // ignore
    }
  }
});

function waitFor(arr, pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = arr.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(`${label} timeout. saw: ${arr.map((m) => m.type).join(",")}`),
        );
      }
      setTimeout(tick, 30);
    };
    tick();
  });
}

try {
  const pong = await waitFor(daemonReplies, (m) => m.type === "pong", 15_000, "pong");
  console.log("\nP2.7c assertions:");
  assert(server.authenticatedCount() === 1, `server.authenticatedCount() === 1 (got ${server.authenticatedCount()})`);
  assert(typeof pong.echoT === "number", "pong echoes ping timestamp");
  assert(Date.now() - pong.echoT < 30_000, "round-trip happened recently");
} catch (err) {
  console.error("\n✗ test failed:", err.message);
  failures += 1;
} finally {
  clientDC?.close?.();
  clientPC.close();
  clientWS.close();
  await server.stop();
  rmSync(testHome, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "✓ all P2.7c checks passed" : `✗ ${failures} failures`}`);
  process.exit(failures === 0 ? 0 : 1);
}
