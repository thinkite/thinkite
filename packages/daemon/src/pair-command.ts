import {
  createHash,
  sign as cryptoSign,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { hostname, networkInterfaces } from "node:os";
import {
  buildClientAuthTranscript,
  HANDSHAKE_VERSION,
  type TranscriptInput,
} from "@sidecodeapp/protocol";
import QRCode from "qrcode";
import { readActiveDaemonLock } from "./daemon-lock.js";
import { resolveSidecodeHome } from "./home.js";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
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

  // Resolve the host the offer should point at. By default we trust the
  // daemon-lock advertisement (loopback for local pairing). For physical-
  // device dev builds the phone is on Wi-Fi and can't reach 127.0.0.1, so
  // we accept `--host <ip>` (or `--lan` to auto-pick the first non-internal
  // IPv4 from this Mac's network interfaces). Daemon itself binds 0.0.0.0
  // by default, so any LAN-reachable IP just works.
  const hostOverride = parseHostOverride(args, lock.host);

  // Build the offer pointing at the running daemon. PairingService here is
  // just a metadata builder; createOffer() is a pure function in the
  // post-revision design — it doesn't track issued offers.
  const pairing = new PairingService(identity, knownClients, {
    daemonAddress: `ws://${hostOverride}:${lock.port}`,
  });
  const offer = pairing.createOffer(`sidecode-${hostname()}`);
  const encoded = Buffer.from(JSON.stringify(offer)).toString("base64url");

  // ASCII QR for the iOS app to scan via expo-camera's CameraView.launchScanner.
  // `small: true` uses half-block characters (▀) so the height is halved —
  // a ~380-char base64url payload renders around 45 lines tall instead of 90,
  // fits in a normal terminal without wrapping. `errorCorrectionLevel: "M"`
  // (~15% recovery) is the qrcode default; bumping to "L" would shrink the
  // grid further but matters very little at this payload size and trades
  // away camera-angle robustness.
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
  console.log(`Address:      ${offer.daemonAddress}`);
  console.log(`Expires:      ${new Date(offer.expiresAt).toISOString()}`);
  console.log("");
  console.log(
    "Offer is valid for ~5 minutes; multiple devices can scan within that window.",
  );
}

/**
 * Resolve the host string the offer should advertise.
 *
 * `sidecode pair`            → use lock.host (loopback by default, OK for
 *                              simulator pairing where the daemon and
 *                              client share the loopback interface)
 * `sidecode pair --host IP`  → use IP verbatim
 * `sidecode pair --lan`      → first non-internal IPv4 on this Mac's
 *                              network interfaces (the typical Wi-Fi IP)
 *
 * Phones on the same Wi-Fi network can't reach the daemon's loopback,
 * which is why this exists.
 */
function parseHostOverride(args: readonly string[], lockHost: string): string {
  const hostIdx = args.indexOf("--host");
  if (hostIdx >= 0) {
    const value = args[hostIdx + 1];
    if (!value || value.startsWith("--")) {
      console.error("✗ --host requires a value (IP or hostname)");
      process.exit(1);
    }
    return value;
  }
  if (args.includes("--lan")) {
    const lan = pickLanIpv4();
    if (!lan) {
      console.error(
        "✗ --lan: no non-internal IPv4 address found. Pass --host <ip> explicitly.",
      );
      process.exit(1);
    }
    return lan;
  }
  return lockHost;
}

/** First non-internal IPv4 across all network interfaces, or undefined. */
function pickLanIpv4(): string | undefined {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const ifc of ifaces ?? []) {
      if (ifc.family === "IPv4" && !ifc.internal) return ifc.address;
    }
  }
  return undefined;
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

  const offer = pairing.createOffer("self-test");
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
