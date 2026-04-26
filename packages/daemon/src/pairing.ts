import {
  createHash,
  randomBytes,
  verify as cryptoVerify,
} from "node:crypto";
import {
  PAIR_OFFER_VERSION,
  type PairAcceptFrame,
  type PairOfferFrame,
  type PairProofFrame,
  type PairRejectFrame,
} from "@sidecodeapp/protocol";
import type { Identity } from "./identity.js";
import { publicKeyFromB64 } from "./identity.js";
import type { KnownClient, KnownClients } from "./known-clients.js";

/** Challenge lifetime in milliseconds. iOS user has 60s to scan + sign. */
export const CHALLENGE_TTL_MS = 60_000;

/** Result of verifyProof — either accepts the client or rejects with a reason. */
export type VerifyResult =
  | { ok: true; accepted: PairAcceptFrame; client: KnownClient }
  | { ok: false; rejected: PairRejectFrame };

export interface PairingServiceOptions {
  /** Override for tests; defaults to Date.now. */
  clock?: () => number;
}

export class PairingService {
  private readonly clock: () => number;
  /** challenge string → expiry ms. Single-use; deleted on verify (regardless of outcome). */
  private readonly pending = new Map<string, number>();

  constructor(
    private readonly identity: Identity,
    private readonly knownClients: KnownClients,
    options: PairingServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Generate a fresh pair.offer. The caller (CLI or WS handler) holds onto
   * the returned `challenge` string and passes it back to verifyProof()
   * when the client's pair.proof arrives.
   */
  createOffer(serviceName: string): { offer: PairOfferFrame; challenge: string } {
    const challenge = randomBytes(32).toString("base64url");
    const expiresAt = this.clock() + CHALLENGE_TTL_MS;
    this.pending.set(challenge, expiresAt);
    const offer: PairOfferFrame = {
      type: "pair.offer",
      v: PAIR_OFFER_VERSION,
      daemonPubkey: this.identity.publicKeyB64,
      fingerprint: this.identity.fingerprint,
      challenge,
      challengeExpiresAt: expiresAt,
      serviceName,
    };
    return { offer, challenge };
  }

  /**
   * Verify a client's pair.proof for the given challenge. Consumes the
   * challenge on first call (success OR failure) — replay safe.
   *
   * The signed payload is SHA256(challenge_bytes || clientPubkey_bytes).
   * Including clientPubkey prevents an attacker from swapping their own
   * pubkey into the proof while reusing a captured signature.
   */
  verifyProof(challenge: string, proof: PairProofFrame): VerifyResult {
    const expiresAt = this.pending.get(challenge);
    if (expiresAt === undefined) {
      return reject("unknown or already-used challenge");
    }
    // Consume immediately — prevents replay even on signature failure.
    this.pending.delete(challenge);

    if (this.clock() > expiresAt) {
      return reject("challenge expired");
    }

    let clientKey: ReturnType<typeof publicKeyFromB64>;
    try {
      clientKey = publicKeyFromB64(proof.clientPubkey);
    } catch (err) {
      return reject(`invalid client public key: ${(err as Error).message}`);
    }

    const challengeBytes = Buffer.from(challenge, "base64url");
    const clientPubBytes = Buffer.from(proof.clientPubkey, "base64url");
    const signedHash = createHash("sha256")
      .update(challengeBytes)
      .update(clientPubBytes)
      .digest();

    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(proof.signature, "base64url");
    } catch {
      return reject("malformed signature");
    }

    const valid = cryptoVerify(null, signedHash, clientKey, signatureBytes);
    if (!valid) return reject("signature verification failed");

    const clientFingerprint = createHash("sha256")
      .update(clientPubBytes)
      .digest("hex")
      .slice(0, 16);

    if (this.knownClients.has(clientFingerprint)) {
      return reject("client already paired");
    }

    const client: KnownClient = {
      fingerprint: clientFingerprint,
      publicKeyB64: proof.clientPubkey,
      pairedAt: this.clock(),
    };
    this.knownClients.add(client);

    return {
      ok: true,
      accepted: { type: "pair.accept", clientFingerprint },
      client,
    };
  }

  /** Drop expired challenges. V0 doesn't auto-call this — challenges are short-lived. */
  prune(): number {
    const now = this.clock();
    let pruned = 0;
    for (const [c, exp] of this.pending) {
      if (now > exp) {
        this.pending.delete(c);
        pruned += 1;
      }
    }
    return pruned;
  }
}

function reject(reason: string): VerifyResult {
  return { ok: false, rejected: { type: "pair.reject", reason } };
}
