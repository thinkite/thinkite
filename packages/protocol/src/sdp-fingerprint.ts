/**
 * Helpers for binding a peer's Ed25519 identity to their WebRTC DTLS
 * fingerprint.
 *
 * WebRTC's SDP carries an ephemeral DTLS certificate fingerprint (one
 * per PeerConnection, regenerated on each pc.createOffer). The
 * fingerprint *is* the cert — DTLS during the data-channel handshake
 * verifies the remote cert matches. But by itself the fingerprint isn't
 * bound to any long-lived identity: anyone who can intercept the SDP
 * (e.g. a compromised signaling worker) can substitute their own
 * fingerprint, then DTLS-handshake successfully with the unsuspecting
 * peer.
 *
 * To pin the DTLS session to the peer's long-lived Ed25519 identity, we
 * sign the canonical fingerprint string ("AB:CD:..." UPPER, exactly as
 * it appears in the SDP after canonicalization) under a versioned
 * domain tag. The remote peer extracts the same fingerprint from the
 * received SDP, recomputes the transcript, and verifies the signature
 * against the pubkey it learned out-of-band (QR for daemon → client;
 * known_clients lookup for client → daemon).
 *
 * Replay safety: an attacker who captures (sdp, sig) can't impersonate
 * because they don't have the daemon's DTLS private key — DTLS will
 * fail at the actual handshake step.
 *
 * Domain tag versioning: `sidecode-dtls-v1`. Bump if we ever change the
 * transcript format (e.g. add the room name, a nonce, etc.).
 */

const DTLS_FP_DOMAIN_TAG = "sidecode-dtls-v1";

/** Matches `a=fingerprint:sha-256 AA:BB:...` in any SDP m-section. */
const FINGERPRINT_RE = /^a=fingerprint:sha-256\s+([0-9A-Fa-f:]+)\s*$/m;

/**
 * Extract the canonical SHA-256 DTLS fingerprint from an SDP.
 *
 * SDP fingerprint lines are case-insensitive in the WebRTC spec; we
 * UPPERCASE both sides of the signature for deterministic transcript
 * bytes. Colons are kept (they're part of the SDP line and harmless).
 *
 * For DataChannel-only PeerConnections we ever build, there's one
 * fingerprint line. If a future m-section ever appears (e.g. media),
 * this returns the first one — but our use case never triggers that.
 */
export function extractDtlsFingerprint(sdp: string): string {
  const match = sdp.match(FINGERPRINT_RE);
  if (!match) {
    throw new Error("no SHA-256 DTLS fingerprint in SDP");
  }
  return match[1].toUpperCase();
}

/**
 * The bytes both sides sign / verify. Wrapping with a domain tag
 * prevents the signature from being cross-protocol-reused (e.g. an
 * attacker can't replay a daemon's fingerprint signature as a signature
 * over something else).
 */
export function dtlsFingerprintTranscript(fingerprint: string): Uint8Array {
  return new TextEncoder().encode(`${DTLS_FP_DOMAIN_TAG}/${fingerprint}`);
}
