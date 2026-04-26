import {
  createHash,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  buildClientAuthTranscript,
  buildTranscript,
  type ClientAuthFrame,
  type ClientHelloFrame,
  HANDSHAKE_VERSION,
  type HandshakeRejectCode,
  type HandshakeRejectFrame,
  type PairOfferFrame,
  type ServerHelloFrame,
  type ServerReadyFrame,
  type TranscriptInput,
} from "@sidecodeapp/protocol";
import type { Identity } from "./identity.js";
import { publicKeyFromB64 } from "./identity.js";
import type { KnownClient, KnownClients } from "./known-clients.js";

/** Default lifetime of a `pair.offer` (the QR is valid this long). */
export const OFFER_TTL_MS = 60_000;

/**
 * Tracked state for a pending pair.offer. Created by `createOffer`,
 * consumed by `processClientHello` when the client connects.
 */
interface PendingOffer {
  sessionId: string;
  serviceName: string;
  expiresAt: number;
}

export interface PairingServiceOptions {
  clock?: () => number;
  /** Network address advertised in the offer (e.g. "ws://192.168.1.5:41234"). */
  daemonAddress?: string;
  /** TTL override for tests. */
  offerTtlMs?: number;
}

export type HelloOutcome =
  | {
      ok: true;
      serverHello: ServerHelloFrame;
      transcriptInput: TranscriptInput;
    }
  | { ok: false; reject: HandshakeRejectFrame };

export type AuthOutcome =
  | {
      ok: true;
      ready: ServerReadyFrame;
      client: KnownClient;
    }
  | { ok: false; reject: HandshakeRejectFrame };

/**
 * State machine for the daemon side of the handshake. One PairingService
 * instance is shared by all WS connections; per-connection state lives in
 * the WS connection handler (Day 3).
 */
export class PairingService {
  private readonly clock: () => number;
  private readonly offerTtlMs: number;
  /** sessionId → pending offer. Pruned on consume + on demand via prune(). */
  private readonly pendingOffers = new Map<string, PendingOffer>();
  /**
   * sessionId → in-flight transcript (built when server.hello is sent,
   * needed again to verify client.auth).
   */
  private readonly pendingTranscripts = new Map<
    string,
    { input: TranscriptInput; deadline: number }
  >();

  constructor(
    private readonly identity: Identity,
    private readonly knownClients: KnownClients,
    private readonly options: PairingServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.offerTtlMs = options.offerTtlMs ?? OFFER_TTL_MS;
  }

  /**
   * Generate a fresh pair.offer to encode in a QR. The returned `sessionId`
   * is the lookup key for when the client later connects with this offer.
   */
  createOffer(serviceName: string): {
    offer: PairOfferFrame;
    sessionId: string;
  } {
    const sessionId = randomUUID();
    const expiresAt = this.clock() + this.offerTtlMs;
    this.pendingOffers.set(sessionId, { sessionId, serviceName, expiresAt });
    const offer: PairOfferFrame = {
      type: "pair.offer",
      v: HANDSHAKE_VERSION,
      sessionId,
      daemonFingerprint: this.identity.fingerprint,
      daemonIdentityPublicKey: this.identity.publicKeyB64,
      daemonAddress: this.options.daemonAddress ?? "ws://127.0.0.1:41234",
      serviceName,
      expiresAt,
    };
    return { offer, sessionId };
  }

  /**
   * Process a `client.hello` frame and produce either a `server.hello`
   * (with daemonSignature over the transcript) or a reject.
   *
   * Pure function as far as outward effects go; internally it stores the
   * transcript so a later `processClientAuth` call can verify against it.
   * The caller is responsible for sending the returned frame over WS.
   */
  processClientHello(hello: ClientHelloFrame): HelloOutcome {
    if (hello.v !== HANDSHAKE_VERSION) {
      return reject(
        hello.sessionId,
        "version_mismatch",
        `client v=${hello.v} expected ${HANDSHAKE_VERSION}`,
      );
    }

    let expiresAt: number;
    let serviceName: string | undefined;

    if (hello.mode === "qr_bootstrap") {
      const offer = this.pendingOffers.get(hello.sessionId);
      if (!offer) {
        return reject(
          hello.sessionId,
          "session_unknown",
          "no pending offer for this sessionId (check QR or regenerate)",
        );
      }
      // Consume eagerly to prevent two clients racing on the same offer.
      this.pendingOffers.delete(hello.sessionId);
      if (this.clock() > offer.expiresAt) {
        return reject(hello.sessionId, "session_expired", "offer expired");
      }
      if (this.knownClients.has(hello.clientFingerprint)) {
        return reject(
          hello.sessionId,
          "client_already_paired",
          "client is already paired; reconnect with mode=trusted_reconnect",
        );
      }
      expiresAt = offer.expiresAt;
      serviceName = offer.serviceName;
    } else {
      // trusted_reconnect: client must already be in known_clients with the
      // exact pubkey it claims.
      const known = this.knownClients.list().find(
        (c) => c.fingerprint === hello.clientFingerprint,
      );
      if (!known) {
        return reject(
          hello.sessionId,
          "client_unknown",
          "no known client with this fingerprint; pair via QR first",
        );
      }
      if (known.publicKeyB64 !== hello.clientIdentityPublicKey) {
        return reject(
          hello.sessionId,
          "invalid_signature",
          "claimed pubkey does not match stored",
        );
      }
      // Synthesize a fresh expiresAt for the transcript (no QR involved).
      expiresAt = this.clock() + this.offerTtlMs;
      serviceName = this.identity.fingerprint; // not strictly used, just non-empty
    }

    void serviceName; // currently unused beyond validation; reserved for future telemetry

    const serverNonce = randomBytes(32).toString("base64url");
    const transcriptInput: TranscriptInput = {
      sessionId: hello.sessionId,
      protocolVersion: HANDSHAKE_VERSION,
      mode: hello.mode,
      keyEpoch: 1,
      daemonFingerprint: this.identity.fingerprint,
      clientFingerprint: hello.clientFingerprint,
      daemonIdentityPublicKey: this.identity.publicKeyB64,
      clientIdentityPublicKey: hello.clientIdentityPublicKey,
      clientNonce: hello.clientNonce,
      serverNonce,
      expiresAt,
    };
    const transcript = buildTranscript(transcriptInput);
    const signature = cryptoSign(null, transcript, this.identity.privateKey);

    // Stash for processClientAuth — short TTL so a stalled client doesn't pin memory.
    this.pendingTranscripts.set(hello.sessionId, {
      input: transcriptInput,
      deadline: this.clock() + this.offerTtlMs,
    });

    const serverHello: ServerHelloFrame = {
      type: "server.hello",
      v: HANDSHAKE_VERSION,
      sessionId: hello.sessionId,
      mode: hello.mode,
      daemonFingerprint: this.identity.fingerprint,
      daemonIdentityPublicKey: this.identity.publicKeyB64,
      serverNonce,
      clientNonce: hello.clientNonce,
      keyEpoch: 1,
      expiresAt,
      daemonSignature: Buffer.from(signature).toString("base64url"),
    };

    return { ok: true, serverHello, transcriptInput };
  }

  /**
   * Process `client.auth`. Verifies the client's signature over
   * (transcript || CLIENT_AUTH_LABEL) using the pubkey already established
   * in `client.hello`. On qr_bootstrap success, persists the new client.
   */
  processClientAuth(auth: ClientAuthFrame): AuthOutcome {
    const pending = this.pendingTranscripts.get(auth.sessionId);
    if (!pending) {
      return reject(
        auth.sessionId,
        "session_unknown",
        "no in-flight handshake for this sessionId",
      );
    }
    // Consume on first attempt — replay-safe under failure too.
    this.pendingTranscripts.delete(auth.sessionId);

    if (this.clock() > pending.deadline) {
      return reject(auth.sessionId, "session_expired", "client.auth too late");
    }
    if (auth.clientFingerprint !== pending.input.clientFingerprint) {
      return reject(
        auth.sessionId,
        "invalid_signature",
        "fingerprint mismatch between hello and auth",
      );
    }

    let clientKey: ReturnType<typeof publicKeyFromB64>;
    try {
      clientKey = publicKeyFromB64(pending.input.clientIdentityPublicKey);
    } catch (err) {
      return reject(
        auth.sessionId,
        "invalid_signature",
        `invalid client pubkey: ${(err as Error).message}`,
      );
    }

    const expected = buildClientAuthTranscript(pending.input);
    let signatureBytes: Buffer;
    try {
      signatureBytes = Buffer.from(auth.clientSignature, "base64url");
    } catch {
      return reject(auth.sessionId, "invalid_signature", "malformed signature");
    }

    const valid = cryptoVerify(null, expected, clientKey, signatureBytes);
    if (!valid) {
      return reject(
        auth.sessionId,
        "invalid_signature",
        "client signature failed verification",
      );
    }

    // Resolve the client record:
    //   qr_bootstrap → first-time, persist and return new entry
    //   trusted_reconnect → must already exist (we re-verify it's there)
    let client: KnownClient | undefined;
    if (pending.input.mode === "qr_bootstrap") {
      // Persist
      client = {
        fingerprint: pending.input.clientFingerprint,
        publicKeyB64: pending.input.clientIdentityPublicKey,
        pairedAt: this.clock(),
      };
      try {
        this.knownClients.add(client);
      } catch {
        // Race: somebody else added the same fingerprint between hello and auth.
        // Treat as already paired — still authenticated, just don't double-add.
        client = this.knownClients.list().find(
          (c) => c.fingerprint === pending.input.clientFingerprint,
        );
        if (!client) {
          return reject(
            auth.sessionId,
            "internal",
            "could not persist nor locate client after race",
          );
        }
      }
    } else {
      client = this.knownClients.list().find(
        (c) => c.fingerprint === pending.input.clientFingerprint,
      );
      if (!client) {
        return reject(
          auth.sessionId,
          "client_unknown",
          "client disappeared from known_clients between hello and auth",
        );
      }
    }

    const ready: ServerReadyFrame = {
      type: "server.ready",
      v: HANDSHAKE_VERSION,
      sessionId: auth.sessionId,
      daemonFingerprint: this.identity.fingerprint,
      keyEpoch: 1,
    };
    return { ok: true, ready, client };
  }

  /** Drop expired offers and stalled transcripts. */
  prune(): { offers: number; transcripts: number } {
    const now = this.clock();
    let offers = 0;
    for (const [k, v] of this.pendingOffers) {
      if (now > v.expiresAt) {
        this.pendingOffers.delete(k);
        offers += 1;
      }
    }
    let transcripts = 0;
    for (const [k, v] of this.pendingTranscripts) {
      if (now > v.deadline) {
        this.pendingTranscripts.delete(k);
        transcripts += 1;
      }
    }
    return { offers, transcripts };
  }
}

function reject(
  sessionId: string | undefined,
  code: HandshakeRejectCode,
  message: string,
): { ok: false; reject: HandshakeRejectFrame } {
  return {
    ok: false,
    reject: {
      type: "handshake.reject",
      v: HANDSHAKE_VERSION,
      sessionId,
      code,
      message,
    },
  };
}
