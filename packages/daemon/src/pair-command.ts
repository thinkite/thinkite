import {
  createHash,
  sign as cryptoSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { hostname } from "node:os";
import {
  buildClientAuthTranscript,
  encodePairOffer,
  HANDSHAKE_VERSION,
  type TranscriptInput,
} from "@sidecodeapp/protocol";
import QRCode from "qrcode";
import { readActiveDaemonLock } from "./daemon-lock.js";
import { resolveSidecodeHome } from "./home.js";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { buildLanAddresses, prioritizedLanIpv4s } from "./lan-addresses.js";
import { PairingService } from "./pairing.js";

/**
 * Implementation of the `sidecode pair` subcommand.
 *
 * Stateless print: reads identity from $SIDECODE_HOME, finds the running
 * `sidecode up` daemon via $SIDECODE_HOME/daemon.lock, and prints a fresh
 * pair.offer payload pointing at that daemon's WS address. Does NOT spawn
 * a server of its own — multiple `sidecode pair` runs are safe and cheap.
 *
 * `--self-test` runs the full handshake in-process without any network —
 * useful for CI / smoke testing.
 */
export async function runPairCommand(args: readonly string[]): Promise<void> {
  if (args.includes("--self-test")) return runSelfTest();

  const home = resolveSidecodeHome();
  const identity = loadOrCreateIdentity(home);
  const knownClients = KnownClients.load(home);

  const lock = readActiveDaemonLock(home);
  if (!lock) {
    console.error("✗ sidecode is not running.");
    console.error("");
    console.error("Start it first:");
    console.error("  sidecode up");
    console.error("");
    console.error("Then re-run `sidecode pair` (in another terminal).");
    process.exit(1);
  }

  // Build the offer's address candidate list. Order is what the iOS client
  // tries sequentially with a per-attempt timeout; first to handshake wins.
  // Priority: any `--host IP` overrides first, then auto-detected LAN
  // (RFC1918 → Tailscale CGNAT → other non-internal IPv4), then loopback.
  const addresses = buildAddressList(args, lock);

  // PairingService is just a metadata builder here; createOffer() is a
  // pure function in the post-revision design — it doesn't track issued
  // offers.
  const pairing = new PairingService(identity, knownClients);
  const offer = pairing.createOffer(hostname(), addresses);
  const encoded = encodePairOffer(offer);

  // ASCII QR for the iOS app to scan via expo-camera's CameraView.launchScanner.
  // `small: true` uses half-block characters (▀) so the height is halved,
  // fitting comfortably in a normal terminal. `errorCorrectionLevel: "M"`
  // is the `qrcode` default (~15% recovery).
  const qr = await QRCode.toString(encoded, {
    type: "terminal",
    small: true,
    errorCorrectionLevel: "M",
  });

  console.log("Scan with sidecode iOS:");
  console.log("");
  console.log(qr);
  console.log("Or paste this payload into the app:");
  console.log("");
  console.log(encoded);
  console.log("");
  console.log(`Daemon PID:   ${lock.pid}`);
  console.log(`Fingerprint:  ${identity.fingerprint}`);
  console.log("Addresses (tried in order):");
  for (const addr of addresses) console.log(`  ${addr}`);
  console.log(`Expires:      ${new Date(offer.expiresAt).toISOString()}`);
  console.log("");
  console.log(
    "Offer is valid for ~5 minutes; multiple devices can scan within that window.",
  );
}

/**
 * Build the ordered ws URL list the offer should advertise.
 *
 * `sidecode pair`            → [LAN IPs (RFC1918), Tailscale (CGNAT),
 *                               other non-internal IPv4s,
 *                               ws://<lock.host>:port]
 * `sidecode pair --host IP`  → [ws://IP:port, …auto LAN…,
 *                               ws://<lock.host>:port]
 *                              (multiple --host flags supported)
 *
 * LAN auto-detection is always on — a CLI that printed loopback-only
 * QRs would only work for the simulator, and the menubar is the canonical
 * physical-device flow anyway. `--host IP` is retained for unusual
 * topologies (e.g. force a specific Tailscale IP over LAN).
 *
 * Why include loopback last: keeps the same offer usable on a simulator
 * running on this Mac (it can also reach the LAN IP, but loopback is
 * fastest and immune to router-level firewall rules).
 *
 * Why RFC1918 before Tailscale CGNAT: when both endpoints are on the same
 * Wi-Fi, LAN is direct and fast; Tailscale on the same LAN tends to fall
 * back to a derp relay or to a peer-to-peer NAT punch that adds latency.
 * On a different network (cellular, hotel Wi-Fi), Tailscale is the only
 * reachable path — that's the fallback case.
 *
 * Dedupe + preserve insertion order: if a `--host` value collides with one
 * the auto-detector would pick, the explicit one wins (placed first) and
 * the duplicate is dropped from the auto-detected slice.
 */
function buildAddressList(
  args: readonly string[],
  lock: { host: string; port: number },
): string[] {
  const explicit = parseHostFlags(args).map((h) => `ws://${h}:${lock.port}`);
  if (explicit.length === 0) {
    return buildLanAddresses(lock.port, lock.host);
  }
  const auto = prioritizedLanIpv4s().map((h) => `ws://${h}:${lock.port}`);
  const loopback = `ws://${lock.host}:${lock.port}`;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const addr of [...explicit, ...auto, loopback]) {
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

/** All `--host <ip>` values in order. Errors out if any is missing a value. */
function parseHostFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "--host") continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      console.error("✗ --host requires a value (IP or hostname)");
      process.exit(1);
    }
    out.push(value);
    i += 1; // skip consumed value
  }
  return out;
}

/** Self-test: run the full handshake in-process. No WS, no network. */
async function runSelfTest(): Promise<void> {
  const home = resolveSidecodeHome();
  const identity = loadOrCreateIdentity(home);
  const known = KnownClients.load(home);
  const pairing = new PairingService(identity, known);

  console.log("=== sidecode pair --self-test ===");
  console.log(`home:        ${home}`);
  console.log(`fingerprint: ${identity.fingerprint}`);

  const offer = pairing.createOffer("self-test", ["ws://127.0.0.1:41234"]);
  console.log(`offer expiresAt: ${new Date(offer.expiresAt).toISOString()}`);

  const { publicKey: clientPub, privateKey: clientPriv } =
    generateKeyPairSync("ed25519");
  const clientPubB64 = (clientPub.export({ format: "jwk" }) as { x: string }).x;
  const clientFingerprint = createHash("sha256")
    .update(Buffer.from(clientPubB64, "base64url"))
    .digest("hex")
    .slice(0, 16);
  const clientNonce = randomBytes(32).toString("base64url");
  const sessionId = randomUUID();

  const helloOutcome = pairing.processClientHello({
    type: "client.hello",
    v: HANDSHAKE_VERSION,
    sessionId,
    mode: "qr_bootstrap",
    clientFingerprint,
    clientIdentityPublicKey: clientPubB64,
    clientNonce,
    offerExpiresAt: offer.expiresAt,
    offerDaemonFingerprint: offer.daemonFingerprint,
  });
  if (!helloOutcome.ok) {
    console.error(
      `✗ client.hello rejected: ${helloOutcome.reject.code} — ${helloOutcome.reject.message}`,
    );
    process.exit(1);
  }
  console.log(
    `→ server.hello signed (signature ${helloOutcome.serverHello.daemonSignature.slice(0, 16)}…)`,
  );

  const transcriptInput: TranscriptInput = {
    sessionId,
    protocolVersion: HANDSHAKE_VERSION,
    mode: "qr_bootstrap",
    keyEpoch: helloOutcome.serverHello.keyEpoch,
    daemonFingerprint: helloOutcome.serverHello.daemonFingerprint,
    clientFingerprint,
    daemonIdentityPublicKey: helloOutcome.serverHello.daemonIdentityPublicKey,
    clientIdentityPublicKey: clientPubB64,
    clientNonce,
    serverNonce: helloOutcome.serverHello.serverNonce,
    expiresAt: helloOutcome.serverHello.expiresAt,
  };
  const sig = cryptoSign(
    null,
    buildClientAuthTranscript(transcriptInput),
    clientPriv,
  );
  const authOutcome = pairing.processClientAuth({
    type: "client.auth",
    v: HANDSHAKE_VERSION,
    sessionId,
    clientFingerprint,
    keyEpoch: helloOutcome.serverHello.keyEpoch,
    clientSignature: Buffer.from(sig).toString("base64url"),
  });
  if (!authOutcome.ok) {
    console.error(
      `✗ client.auth rejected: ${authOutcome.reject.code} — ${authOutcome.reject.message}`,
    );
    process.exit(1);
  }
  console.log(
    `✓ pair accepted: client fingerprint ${authOutcome.client.fingerprint}`,
  );
  console.log(`  (writes a real entry into ${home}/known_clients.json)`);
}
