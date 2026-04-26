import {
  createHash,
  randomBytes,
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

/**
 * Default lifetime of an offer. Long enough to scan + connect with margin
 * for menu bar UX (user opens popover, scans, completes); short enough that
 * a captured QR isn't usable for days.
 */
export const OFFER_TTL_MS = 5 * 60_000; // 5 minutes

/** TTL for in-flight handshake transcripts (between hello and auth). */
export const TRANSCRIPT_TTL_MS = 30_000;

export interface PairingServiceOptions {
  clock?: () => number;
  /** Network address advertised in the offer (e.g. "ws://192.168.1.5:41234"). */
  daemonAddress?: string;
  /** Override the default 5-minute offer expiry. */
  offerTtlMs?: number;
  /** Override the per-handshake transcript TTL. */
  transcriptTtlMs?: number;
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
 * Daemon-side of the handshake state machine.
 *
 * In the new (post-Day-3-revision) design, offers are STATELESS — the
 * daemon doesn't track which offers it has issued. `createOffer()` is a
 * pure function over the daemon's identity + the requested expiresAt.
 *
 * The only mutable state is `pendingTranscripts`, which threads
 * client.hello → server.hello → client.auth through a single transcript.
 * That state is per-handshake, short-lived, and consumed on first auth.
 */
export class PairingService {
  private readonly clock: () => number;
  private readonly offerTtlMs: number;
  private readonly transcriptTtlMs: number;
  private readonly daemonAddress: string;
  /** sessionId (client-generated) → in-flight transcript. */
  private readonly pendingTranscripts = new Map<
    string,
    { input: TranscriptInput; deadline: number }
  >();

  constructor(
    private readonly identity: Identity,
    private readonly knownClients: KnownClients,
    options: PairingServiceOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    this.offerTtlMs = options.offerTtlMs ?? OFFER_TTL_MS;
    this.transcriptTtlMs = options.transcriptTtlMs ?? TRANSCRIPT_TTL_MS;
    this.daemonAddress = options.daemonAddress ?? "ws://127.0.0.1:41234";
  }

  /**
   * Generate a fresh pair.offer. Pure function — does not mutate any
   * service state. The returned offer is valid for `expiresAt` worth of
   * time and can be scanned multiple times within that window.
   */
  createOffer(serviceName: string): PairOfferFrame {
    const expiresAt = this.clock() + this.offerTtlMs;
    return {
      type: "pair.offer",
      v: HANDSHAKE_VERSION,
      daemonFingerprint: this.identity.fingerprint,
      daemonIdentityPublicKey: this.identity.publicKeyB64,
      daemonAddress: this.daemonAddress,
      serviceName,
      expiresAt,
    };
  }

  /**
   * Process a `client.hello` frame and produce either a `server.hello`
   * (with daemonSignature over the transcript) or a reject.
   *
   * For qr_bootstrap, validates the echoed offer fields (offerExpiresAt
   * not yet passed; offerDaemonFingerprint matches our identity).
   * For trusted_reconnect, looks up the client in known_clients and
   * synthesizes a fresh expiresAt for the transcript.
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

    if (hello.mode === "qr_bootstrap") {
      if (
        hello.offerDaemonFingerprint === undefined ||
        hello.offerExpiresAt === undefined
      ) {
        return reject(
          hello.sessionId,
          "internal",
          "qr_bootstrap requires offerDaemonFingerprint + offerExpiresAt",
        );
      }
      if (hello.offerDaemonFingerprint !== this.identity.fingerprint) {
        return reject(
          hello.sessionId,
          "internal",
          "offer was for a different daemon",
        );
      }
      if (this.clock() > hello.offerExpiresAt) {
        return reject(hello.sessionId, "session_expired", "offer expired");
      }
      if (this.knownClients.has(hello.clientFingerprint)) {
        return reject(
          hello.sessionId,
          "client_already_paired",
          "client is already paired; reconnect with mode=trusted_reconnect",
        );
      }
      expiresAt = hello.offerExpiresAt;
    } else {
      // trusted_reconnect
      const known = this.knownClients
        .list()
        .find((c) => c.fingerprint === hello.clientFingerprint);
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
      // Synthesize fresh expiresAt for the transcript. No QR to anchor to.
      expiresAt = this.clock() + this.offerTtlMs;
    }

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

    // Stash for processClientAuth — short-lived per-handshake state.
    this.pendingTranscripts.set(hello.sessionId, {
      input: transcriptInput,
      deadline: this.clock() + this.transcriptTtlMs,
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

    let client: KnownClient | undefined;
    if (pending.input.mode === "qr_bootstrap") {
      client = {
        fingerprint: pending.input.clientFingerprint,
        publicKeyB64: pending.input.clientIdentityPublicKey,
        pairedAt: this.clock(),
      };
      try {
        this.knownClients.add(client);
      } catch {
        // Race: another concurrent qr_bootstrap added the same fingerprint
        // between this hello and this auth. Treat as authenticated; just
        // don't double-add.
        client = this.knownClients
          .list()
          .find((c) => c.fingerprint === pending.input.clientFingerprint);
        if (!client) {
          return reject(
            auth.sessionId,
            "internal",
            "could not persist nor locate client after race",
          );
        }
      }
    } else {
      client = this.knownClients
        .list()
        .find((c) => c.fingerprint === pending.input.clientFingerprint);
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

  /** Drop stalled in-flight transcripts. Offers are stateless so nothing
   *  to prune for them. */
  prune(): { transcripts: number } {
    const now = this.clock();
    let transcripts = 0;
    for (const [k, v] of this.pendingTranscripts) {
      if (now > v.deadline) {
        this.pendingTranscripts.delete(k);
        transcripts += 1;
      }
    }
    return { transcripts };
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

// suppress unused: createHash is no longer used in this file but kept import
// for transcript-related tooling that may follow. (Vitest tree-shaker won't
// strip it; tsc will warn. Re-export elsewhere if useful.)
void createHash;
