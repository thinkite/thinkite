#!/usr/bin/env node
/**
 * Smoke test: spawn a mock daemon + mock client against `wrangler dev`,
 * verify signaling round-trip. Run with `wrangler dev` already up on
 * :8787 in another shell:
 *
 *     pnpm wrangler dev --port 8787   # terminal A
 *     node scripts/smoke.mjs          # terminal B
 *
 * Asserts:
 *  1. Bad signature → daemon connection closed with bad_signature.
 *  2. Good signature → daemon connection accepted, sees peers list.
 *  3. Client connects → daemon receives peer.joined.
 *  4. Client sends `{to: daemonId, type: "offer", ...}` → daemon receives
 *     it with server-stamped `from`.
 *  5. Daemon replies with `{to: clientId, type: "answer", ...}` → client receives.
 *  6. Client closes → daemon receives peer.left.
 */

import {
  sign as cryptoSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

// Default to local `wrangler dev`; override with SIGNALING_URL=wss://... to
// smoke-test a deployed Worker. Example:
//   SIGNALING_URL=wss://sidecode-signaling.<acct>.workers.dev node scripts/smoke.mjs
const HOST = process.env.SIGNALING_URL ?? "ws://localhost:8787";

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failures += 1;
  }
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function open(url, label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const messages = [];
    ws.addEventListener("message", (e) => {
      const text =
        typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data);
      messages.push(JSON.parse(text));
    });
    ws.addEventListener("open", () => resolve({ ws, messages, label }));
    ws.addEventListener("error", (e) =>
      reject(new Error(`${label}: ws error`)),
    );
    ws.addEventListener("close", (e) => {
      ws._closeInfo = { code: e.code, reason: e.reason };
    });
    setTimeout(() => reject(new Error(`${label}: open timeout`)), 5000);
  });
}

function waitFor(messages, pred, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const hit = messages.find(pred);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(`waitFor timeout. saw: ${JSON.stringify(messages)}`),
        );
      }
      setTimeout(tick, 30);
    };
    tick();
  });
}

function waitForClose(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (ws._closeInfo) return resolve(ws._closeInfo);
      if (Date.now() - start > timeoutMs)
        return reject(new Error("close timeout"));
      setTimeout(tick, 30);
    };
    tick();
  });
}

async function main() {
  // Generate a daemon Ed25519 keypair (room = its pubkey).
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubRaw = publicKey.export({ format: "jwk" });
  // jwk.x is the raw pubkey in base64url already.
  const daemonPubkey = pubRaw.x;
  console.log(`daemon pubkey: ${daemonPubkey}`);

  const clientKeypair = generateKeyPairSync("ed25519");
  const clientPubkey = clientKeypair.publicKey.export({ format: "jwk" }).x;
  console.log(`client pubkey: ${clientPubkey}`);

  const room = encodeURIComponent(daemonPubkey);

  console.log("\n[1] daemon with BAD signature is rejected pre-upgrade");
  // onBeforeConnect returns 401 BEFORE WebSocket upgrade. Node's built-in
  // WebSocket fires an "error" event; we never see "open".
  const badTs = Date.now();
  const badSig = b64url(randomBytes(64));
  const badUrl = `${HOST}/parties/signaling/${room}?role=daemon&ts=${badTs}&sig=${badSig}`;
  const badEvent = await new Promise((resolve) => {
    const ws = new WebSocket(badUrl);
    ws.addEventListener("open", () => resolve({ type: "open" }));
    ws.addEventListener("error", () => resolve({ type: "error" }));
    setTimeout(() => resolve({ type: "timeout" }), 3000);
  });
  assert(
    badEvent.type === "error",
    `bad_signature triggers error event (got ${badEvent.type})`,
  );

  console.log("\n[2] daemon with GOOD signature is accepted");
  const ts = Date.now();
  const msg = Buffer.from(`signaling/v1/${daemonPubkey}/${ts}`);
  const sig = b64url(cryptoSign(null, msg, privateKey));
  const daemonUrl = `${HOST}/parties/signaling/${room}?role=daemon&ts=${ts}&sig=${sig}`;
  const daemon = await open(daemonUrl, "daemon");
  const initialPeers = await waitFor(
    daemon.messages,
    (m) => m.type === "peers",
  );
  assert(
    Array.isArray(initialPeers.peers),
    "daemon got peers frame on connect",
  );
  assert(initialPeers.peers.length === 0, "no clients online yet");

  console.log("\n[3] client connects → daemon receives peer.joined");
  const clientUrl = `${HOST}/parties/signaling/${room}?role=client&pubkey=${encodeURIComponent(clientPubkey)}`;
  const client = await open(clientUrl, "client");
  const joined = await waitFor(
    daemon.messages,
    (m) => m.type === "peer.joined",
  );
  assert(
    joined.peer.pubkey === clientPubkey,
    "peer.joined carries correct client pubkey",
  );
  assert(
    typeof joined.peer.id === "string",
    "peer.joined carries client connection id",
  );
  const clientPeerId = joined.peer.id;

  console.log("\n[4] client also sees daemon in its initial peers frame");
  const clientPeers = await waitFor(client.messages, (m) => m.type === "peers");
  assert(clientPeers.peers.length === 1, "client sees exactly 1 daemon");
  assert(clientPeers.peers[0].role === "daemon", "peer role is daemon");
  const daemonPeerId = clientPeers.peers[0].id;

  console.log("\n[5] message routing by `to` field, `from` server-stamped");
  // client → daemon
  client.ws.send(
    JSON.stringify({ to: daemonPeerId, type: "offer", sdp: "v=0..." }),
  );
  const offer = await waitFor(daemon.messages, (m) => m.type === "offer");
  assert(offer.sdp === "v=0...", "daemon receives offer payload");
  assert(offer.from === clientPeerId, "`from` server-stamped to sender id");
  assert(offer.to === daemonPeerId, "`to` preserved");
  // daemon → client
  daemon.ws.send(
    JSON.stringify({ to: clientPeerId, type: "answer", sdp: "v=1..." }),
  );
  const answer = await waitFor(client.messages, (m) => m.type === "answer");
  assert(answer.sdp === "v=1...", "client receives answer payload");
  assert(answer.from === daemonPeerId, "client sees `from = daemon`");

  console.log("\n[6] sending to a non-existent id returns error");
  client.ws.send(JSON.stringify({ to: "no-such-id", type: "offer" }));
  const err = await waitFor(client.messages, (m) => m.type === "error");
  assert(err.reason === "peer_not_found", "error.reason = peer_not_found");
  assert(err.to === "no-such-id", "error includes the bad to");

  console.log("\n[7] client closes → daemon receives peer.left");
  client.ws.close();
  const left = await waitFor(daemon.messages, (m) => m.type === "peer.left");
  assert(left.peer.id === clientPeerId, "peer.left has correct id");

  console.log("\n[8] new daemon replaces old daemon");
  const ts2 = Date.now();
  const sig2 = b64url(
    cryptoSign(
      null,
      Buffer.from(`signaling/v1/${daemonPubkey}/${ts2}`),
      privateKey,
    ),
  );
  const daemon2Url = `${HOST}/parties/signaling/${room}?role=daemon&ts=${ts2}&sig=${sig2}`;
  await open(daemon2Url, "daemon2");
  const closeInfo = await waitForClose(daemon.ws);
  assert(closeInfo.code === 1008, "old daemon closed with policy violation");
  assert(
    closeInfo.reason === "replaced_by_new_daemon",
    "reason = replaced_by_new_daemon",
  );

  console.log(
    `\n${failures === 0 ? "✓ all checks passed" : `✗ ${failures} failures`}`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
