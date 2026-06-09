#!/usr/bin/env node
/**
 * P2.4 spike: close the WebRTC handshake loop end-to-end.
 *
 * Builds on p2-orchestrator-spike.mjs by adding the mock client's
 * answer path:
 *
 *   1. Daemon: peer.joined → createOffer → send via signaling
 *   2. Client: receive offer → setRemoteDescription → createAnswer →
 *      setLocalDescription → send via signaling
 *   3. Daemon: receive answer → setRemoteDescription
 *   4. Both sides: candidate event → forward via signaling
 *   5. Both sides: receive candidate → addIceCandidate
 *
 * Assertions:
 *   - Both PeerConnections reach connectionState=connected
 *   - DataChannel reaches readyState=open on both ends
 *   - Bidirectional send/recv actually works
 *
 * No TURN configured — relies on host candidates (both PCs are in this
 * process). Validates the full WebRTC + signaling integration without
 * needing real network traversal.
 *
 * Run:
 *   node packages/daemon/scripts/p2-handshake-spike.mjs
 */
import { sign as cryptoSign, generateKeyPairSync } from "node:crypto";
import {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from "node-datachannel/polyfill";
import { WebSocket } from "partysocket";
import { resolveSidecodeHome } from "../dist/home.js";
import { loadOrCreateIdentity } from "../dist/identity.js";

const HOST = process.env.SIGNALING_HOST ?? "signaling.sidecode.app";
const SCHEME = process.env.SIGNALING_INSECURE === "1" ? "ws" : "wss";
const ICE_SERVERS = [{ urls: "stun:stun.cloudflare.com:3478" }];

const home = resolveSidecodeHome();
const daemon = loadOrCreateIdentity(home);
console.log(`daemon identity: ${daemon.fingerprint}`);

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
  return `${SCHEME}://${HOST}/parties/signaling/${daemon.publicKeyB64}?${new URLSearchParams({ role: "daemon", ts: String(ts), sig })}`;
}
function buildClientUrl() {
  return `${SCHEME}://${HOST}/parties/signaling/${daemon.publicKeyB64}?${new URLSearchParams({ role: "client", pubkey: clientPubB64 })}`;
}

function waitForOpen(ws, label) {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.addEventListener("open", () => resolve());
    setTimeout(() => reject(new Error(`${label}: open timeout`)), 5000);
  });
}

function waitForState(pc, predicate, label, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    if (predicate()) return resolve();
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `${label}: timeout (state=${pc.connectionState}/${pc.iceConnectionState})`,
          ),
        );
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

// === Daemon (offerer) ===
const activePCs = new Map();
let daemonOwnedDataChannel = null;
const daemonWS = new WebSocket(buildDaemonUrl, undefined, { maxRetries: 3 });

daemonWS.addEventListener("message", async (e) => {
  const text =
    typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
  const msg = JSON.parse(text);

  if (msg.type === "peer.joined") {
    const clientId = msg.peer.id;
    console.log(`[daemon] peer.joined ${clientId}`);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    activePCs.set(clientId, pc);

    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        const cand = event.candidate.toJSON
          ? event.candidate.toJSON()
          : { candidate: String(event.candidate) };
        daemonWS.send(
          JSON.stringify({ to: clientId, type: "candidate", candidate: cand }),
        );
      }
    });

    const dc = pc.createDataChannel("sidecode/v1", { ordered: true });
    daemonOwnedDataChannel = dc;
    dc.addEventListener("open", () => {
      console.log(`[daemon] DataChannel open, sending hello`);
      dc.send("hello from daemon");
    });
    dc.addEventListener("message", (event) => {
      console.log(`[daemon] DC recv: ${event.data}`);
      daemonOwnedDataChannel._lastMessage = event.data;
    });

    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    daemonWS.send(
      JSON.stringify({ to: clientId, type: "offer", sdp: offer.sdp }),
    );
  } else if (msg.type === "answer") {
    const pc = activePCs.get(msg.from);
    if (!pc) {
      console.error(`[daemon] answer for unknown peer ${msg.from}`);
      return;
    }
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp: msg.sdp }),
    );
    console.log(`[daemon] setRemoteDescription(answer) for ${msg.from}`);
  } else if (msg.type === "candidate") {
    const pc = activePCs.get(msg.from);
    if (!pc) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (err) {
      console.warn(`[daemon] addIceCandidate failed:`, err.message);
    }
  }
});

await waitForOpen(daemonWS, "daemon");

// === Mock Client (answerer) ===
const clientPC = new RTCPeerConnection({ iceServers: ICE_SERVERS });
let clientReceivedDataChannel = null;
let daemonPeerId = null;
const clientWS = new WebSocket(buildClientUrl(), undefined, { maxRetries: 3 });

clientPC.addEventListener("icecandidate", (event) => {
  if (event.candidate && daemonPeerId) {
    const cand = event.candidate.toJSON
      ? event.candidate.toJSON()
      : { candidate: String(event.candidate) };
    clientWS.send(
      JSON.stringify({ to: daemonPeerId, type: "candidate", candidate: cand }),
    );
  }
});

// Client receives DataChannel via "datachannel" event (server pushes its created channel)
clientPC.addEventListener("datachannel", (event) => {
  const dc = event.channel;
  clientReceivedDataChannel = dc;
  dc.addEventListener("open", () => {
    console.log(`[client] DataChannel open, sending hello`);
    dc.send("hello from client");
  });
  dc.addEventListener("message", (event) => {
    console.log(`[client] DC recv: ${event.data}`);
    clientReceivedDataChannel._lastMessage = event.data;
  });
});

clientWS.addEventListener("message", async (e) => {
  const text =
    typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
  const msg = JSON.parse(text);

  if (msg.type === "peers") {
    const daemonPeer = msg.peers.find((p) => p.role === "daemon");
    if (daemonPeer) daemonPeerId = daemonPeer.id;
  } else if (msg.type === "offer") {
    daemonPeerId = msg.from;
    console.log(`[client] offer received from ${daemonPeerId}`);
    await clientPC.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp: msg.sdp }),
    );
    const answer = await clientPC.createAnswer();
    await clientPC.setLocalDescription(answer);
    clientWS.send(
      JSON.stringify({ to: msg.from, type: "answer", sdp: answer.sdp }),
    );
    console.log(`[client] answer sent`);
  } else if (msg.type === "candidate") {
    try {
      await clientPC.addIceCandidate(new RTCIceCandidate(msg.candidate));
    } catch (err) {
      console.warn(`[client] addIceCandidate failed:`, err.message);
    }
  }
});

await waitForOpen(clientWS, "client");
console.log("[client] connected");

// === Wait for both ends to reach connected ===
const daemonPC = await new Promise((resolve) => {
  const tick = () =>
    activePCs.size > 0
      ? resolve([...activePCs.values()][0])
      : setTimeout(tick, 50);
  tick();
});

console.log("\nwaiting for handshake to complete...");
await Promise.all([
  waitForState(
    daemonPC,
    () => daemonPC.connectionState === "connected",
    "daemon PC connected",
  ),
  waitForState(
    clientPC,
    () => clientPC.connectionState === "connected",
    "client PC connected",
  ),
]);

// === Assertions ===
console.log("\nP2.4 assertions:");
assert(
  daemonPC.connectionState === "connected",
  "daemon PC connectionState = connected",
);
assert(
  clientPC.connectionState === "connected",
  "client PC connectionState = connected",
);
assert(
  daemonOwnedDataChannel?.readyState === "open",
  "daemon DataChannel = open",
);
assert(
  clientReceivedDataChannel?.readyState === "open",
  "client DataChannel = open (via datachannel event)",
);

// Wait for messages to be exchanged
await new Promise((r) => setTimeout(r, 500));
assert(
  daemonOwnedDataChannel?._lastMessage === "hello from client",
  `daemon received client's message (got: ${daemonOwnedDataChannel?._lastMessage})`,
);
assert(
  clientReceivedDataChannel?._lastMessage === "hello from daemon",
  `client received daemon's message (got: ${clientReceivedDataChannel?._lastMessage})`,
);

console.log("\nfinal PC state:");
console.log(
  `  daemon:  connectionState=${daemonPC.connectionState}, iceConnectionState=${daemonPC.iceConnectionState}`,
);
console.log(
  `  client:  connectionState=${clientPC.connectionState}, iceConnectionState=${clientPC.iceConnectionState}`,
);

// Cleanup
for (const pc of activePCs.values()) pc.close();
clientPC.close();
daemonWS.close();
clientWS.close();
await new Promise((r) => setTimeout(r, 300));

console.log(
  `\n${failures === 0 ? "✓ all P2.4 checks passed — full WebRTC handshake works" : `✗ ${failures} failures`}`,
);
process.exit(failures === 0 ? 0 : 1);
