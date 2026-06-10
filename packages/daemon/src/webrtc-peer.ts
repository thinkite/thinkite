import {
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  type ChunkEnvelope,
  ChunkReassembler,
  type ClientFrame,
  type Command,
  chunkMessage,
  clientFrame,
  type DaemonFrame,
  dtlsFingerprintTranscript,
  extractDtlsFingerprint,
  isChunkEnvelope,
  isProtocolCompatible,
  PROTOCOL_VERSION,
} from "@sidecodeapp/protocol";
import {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from "node-datachannel/polyfill";
import PartySocket from "partysocket";
import type { CommandContext, CommandHandler } from "./command.js";
import type { Identity } from "./identity.js";
import { publicKeyFromB64 } from "./identity.js";
import type { KnownClients } from "./known-clients.js";

/**
 * WebRTC-DataChannel transport with **DTLS-fingerprint-pinned identity**.
 *
 * Identity binding lives at the DTLS layer instead of in an application-
 * layer handshake:
 *
 *   1. Daemon creates offer; SDP contains an ephemeral DTLS cert
 *      fingerprint.
 *   2. Daemon signs that fingerprint under a domain tag with its long-
 *      lived Ed25519 key and forwards { sdp, fpSig } via signaling.
 *   3. Client (knowing daemon's pubkey from the QR) verifies fpSig
 *      against the fingerprint in the received SDP. A malicious signaling
 *      worker swapping the fingerprint is caught here, BEFORE DTLS even
 *      starts.
 *   4. Client mirrors the same fp-sign step in its answer.
 *   5. Daemon verifies the answer signature against the client's known
 *      pubkey (looked up in `known_clients.json` via the pubkey the
 *      client self-declared on the signaling side).
 *   6. DTLS handshake completes — the session is now bound to identities
 *      verified out-of-band (QR for daemon → client, pair flow for
 *      client → daemon).
 *   7. DataChannel opens. Frames received from this point are implicitly
 *      from the authenticated peer.
 *   8. Wire-version handshake: client sends `hello`, daemon validates
 *      protocol-version overlap and responds with `server_info`, then
 *      application commands are dispatched to `commandHandler`.
 *
 * Pair-window admission (admitting a new client pubkey to known_clients)
 * is gated by `isPairing` — when true, unknown pubkeys are admitted; when
 * false, they're silently rejected. The menubar UI controls this gate
 * via its `createPairOffer` cadence; tests pre-pair via `knownClients.add()`.
 */

const DEFAULT_SIGNALING_HOST = "signaling.sidecode.app";
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

/**
 * Max time from `peer.joined` to `authenticated` (= DataChannel open).
 * Normal path completes in well under 5s on a clean network; 30s gives
 * generous headroom for TURN-relayed sessions over flaky links while
 * still capping how long a stuck slot ties up memory.
 */
const SETUP_TIMEOUT_MS = 30_000;

export interface WebRTCPeerServerOptions {
  /** Daemon's long-lived Ed25519 identity. Signs DTLS fingerprints +
   *  proves daemon-ownership of the room to the signaling worker. */
  identity: Identity;
  /** Source of truth for "which iOS pubkeys is this daemon paired with."
   *  Looked up on every `peer.joined`. */
  knownClients: KnownClients;
  /** Invoked for each application command after the per-peer wire-version
   *  handshake (hello / server_info) completes. The DataChannel is
   *  DTLS-bound to a known pubkey by the time we get here, AND the peer
   *  has proven it speaks a compatible wire-protocol version. */
  commandHandler?: CommandHandler;
  /**
   * Runtime gate for admitting new iOS pubkeys via the pair-window UI.
   * When `true`, an unknown clientPubkey is added to known_clients on
   * connect. When `false`, unknown pubkeys are rejected silently. The
   * menubar flips this when the QR window opens/closes; tests default
   * to `false` since they pre-pair via `knownClients.add()`.
   */
  isPairing?: () => boolean;
  /** Override for tests (e.g. local `wrangler dev`). */
  signalingHost?: string;
  signalingScheme?: "ws" | "wss";
  iceServers?: RTCIceServer[];
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/**
 * Per-peer slot. No application-layer auth state machine — the
 * "authenticated" boolean flips true once DataChannel opens (which only
 * succeeds after DTLS verifies the signed fingerprint).
 */
interface PeerSlot {
  /** Signaling-assigned connection id (server-stamped, opaque). */
  clientId: string;
  /** Pubkey from `peer.joined` (matched against known_clients before we
   *  accept the slot). After this point we treat the pubkey as
   *  authoritative — it's bound to the DTLS session via fpSig. */
  clientPubkey: string;
  /** Short hex fingerprint for log + CommandContext compatibility. */
  fingerprint: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  /** True once DTLS+DataChannel is up (= peer has been cryptographically
   *  bound to clientPubkey). */
  authenticated: boolean;
  /** True once the client's `hello` has arrived AND its protocolVersion
   *  is wire-compatible with ours. Application commands sent before
   *  this flips are rejected with `incompatible_protocol`. */
  versionVerified: boolean;
  /** Cleared the moment `authenticated` flips true. Reaps slots whose
   *  PC is stuck pre-auth (e.g. client died before sending answer, so
   *  ICE never starts and `connectionstatechange` never fires). */
  setupTimeoutId: ReturnType<typeof setTimeout> | null;
  /** Per-peer buffer for inbound chunk envelopes. Each PeerSlot has
   *  its own — chunk ids are scoped to the sender, and a stale buffer
   *  from a dropped peer mustn't bleed into a fresh one. */
  reassembler: ChunkReassembler;
  disconnectCallbacks: Array<() => void>;
  scratch: Map<string, unknown>;
}

export class WebRTCPeerServer {
  private signaling: PartySocket | null = null;
  private readonly peers = new Map<string, PeerSlot>();
  private readonly log: NonNullable<WebRTCPeerServerOptions["log"]>;
  private readonly identity: Identity;
  private readonly knownClients: KnownClients;
  private readonly commandHandler?: CommandHandler;
  private readonly isPairing: () => boolean;
  private readonly signalingHost: string;
  private readonly signalingScheme: "ws" | "wss";
  private readonly iceServers: RTCIceServer[];

  constructor(options: WebRTCPeerServerOptions) {
    this.identity = options.identity;
    this.knownClients = options.knownClients;
    this.commandHandler = options.commandHandler;
    this.isPairing = options.isPairing ?? (() => false);
    this.signalingHost = options.signalingHost ?? DEFAULT_SIGNALING_HOST;
    this.signalingScheme = options.signalingScheme ?? "wss";
    this.iceServers = options.iceServers ?? DEFAULT_ICE_SERVERS;
    this.log = options.log ?? (() => undefined);
  }

  start(): void {
    if (this.signaling) throw new Error("WebRTCPeerServer already started");

    this.signaling = new PartySocket({
      host: this.signalingHost,
      protocol: this.signalingScheme,
      party: "signaling",
      room: this.identity.publicKeyB64,
      // Per-reconnect sig refresh keeps ts/sig inside the worker's ±60s
      // skew window even after long backoff cycles.
      query: async () => {
        const ts = Date.now();
        const sig = cryptoSign(
          null,
          Buffer.from(`signaling/v1/${this.identity.publicKeyB64}/${ts}`),
          this.identity.privateKey,
        ).toString("base64url");
        return { role: "daemon", ts: String(ts), sig };
      },
      maxRetries: Infinity,
    });

    this.signaling.addEventListener("message", (e: MessageEvent) => {
      const text =
        typeof e.data === "string"
          ? e.data
          : new TextDecoder().decode(e.data as ArrayBuffer);
      void this.onSignalingMessage(JSON.parse(text));
    });
    this.signaling.addEventListener("open", () => this.log("signaling.open"));
    this.signaling.addEventListener("close", (e: CloseEvent) => {
      this.log("signaling.close", { code: e.code, reason: e.reason });
    });
    this.signaling.addEventListener("error", (e: Event) => {
      this.log("signaling.error", {
        error: (e as ErrorEvent)?.message ?? "unknown",
      });
    });

    // Fire-and-forget. Daemon shouldn't refuse to start just because
    // signaling.sidecode.app is momentarily unreachable — PartySocket's
    // infinite retry will eventually connect when the network heals, and
    // until then pair attempts time out client-side. The previous
    // synchronous await-for-peers was a debugging-era affordance; in
    // production a daemon that boots cleanly and surfaces "signaling.open"
    // in its log is the right model.
  }

  async stop(): Promise<void> {
    if (!this.signaling) return;
    for (const peer of [...this.peers.values()]) {
      this.closePeer(peer, "shutdown");
    }
    this.peers.clear();
    try {
      this.signaling.close();
    } catch {
      // ignore
    }
    this.signaling = null;
  }

  /** Number of peers with an open DTLS-verified DataChannel. */
  authenticatedCount(): number {
    let n = 0;
    for (const p of this.peers.values()) if (p.authenticated) n += 1;
    return n;
  }

  // ─── Signaling-frame router ──────────────────────────────────────

  private async onSignalingMessage(msg: unknown): Promise<void> {
    if (!isRecord(msg) || typeof msg.type !== "string") return;

    if (msg.type === "peers") {
      this.log("signaling.peers", {
        count: Array.isArray(msg.peers) ? msg.peers.length : 0,
      });
      return;
    }
    if (msg.type === "peer.joined" && isRecord(msg.peer)) {
      await this.onPeerJoined({
        id: String(msg.peer.id ?? ""),
        pubkey: String(msg.peer.pubkey ?? ""),
        role: String(msg.peer.role ?? ""),
      });
      return;
    }
    // Intentionally no handler for `peer.left`. Signaling is a setup-
    // time channel; once the DataChannel is up it has nothing left to
    // say about transport health. iOS routinely closes its signaling
    // socket right after `server_info` to free the worker connection,
    // which would surface here as `peer.left` — acting on it would
    // tear down a perfectly healthy DC. PC health is driven by
    // `connectionstatechange` (failed/closed/disconnected). For the
    // edge case where a client bails BEFORE we get an answer (PC
    // stuck in `have-local-offer`, ICE never starts checking, so
    // `connectionstatechange` never fires), the per-slot setup
    // timeout below reaps the slot.
    if (msg.type === "answer" && typeof msg.from === "string") {
      await this.onAnswer(msg.from, msg);
      return;
    }
    if (msg.type === "candidate" && typeof msg.from === "string") {
      const peer = this.peers.get(msg.from);
      if (!peer) return;
      try {
        await peer.pc.addIceCandidate(
          new RTCIceCandidate(msg.candidate as RTCIceCandidateInit),
        );
      } catch (err) {
        this.log("peer.candidate.error", {
          clientId: peer.clientId,
          error: (err as Error).message,
        });
      }
      return;
    }
  }

  // ─── Peer lifecycle ──────────────────────────────────────────────

  private async onPeerJoined(peer: {
    id: string;
    pubkey: string;
    role: string;
  }): Promise<void> {
    if (peer.role !== "client" || !peer.id || !peer.pubkey) return;
    if (this.peers.has(peer.id)) return; // duplicate event

    // Pubkey gate: must be in known_clients, OR we're in pair-window
    // mode (in which case admit them and persist). New pubkeys arriving
    // while the menubar Pair window is closed are silently rejected —
    // signaling DO routes the connection to us but we never respond
    // with an offer, so the client's reconnect loop will time out.
    let knownClient = this.knownClientByPubkey(peer.pubkey);
    if (!knownClient) {
      if (!this.isPairing()) {
        this.log("peer.rejected_unknown", {
          clientId: peer.id,
          pubkey: peer.pubkey.slice(0, 12),
        });
        return;
      }
      const fingerprint = fingerprintFromPubkey(peer.pubkey);
      knownClient = {
        fingerprint,
        publicKeyB64: peer.pubkey,
        pairedAt: Date.now(),
      };
      this.knownClients.add(knownClient);
      this.log("peer.paired", { clientId: peer.id, fingerprint });
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const slot: PeerSlot = {
      clientId: peer.id,
      clientPubkey: peer.pubkey,
      fingerprint: knownClient.fingerprint,
      pc,
      dc: null,
      authenticated: false,
      versionVerified: false,
      setupTimeoutId: null,
      reassembler: new ChunkReassembler(),
      disconnectCallbacks: [],
      scratch: new Map(),
    };
    this.peers.set(peer.id, slot);
    slot.setupTimeoutId = setTimeout(() => {
      if (slot.authenticated) return;
      this.closePeer(slot, "setup timeout");
    }, SETUP_TIMEOUT_MS);

    pc.addEventListener("icecandidate", (event) => {
      const candidate = (
        event as unknown as { candidate?: RTCIceCandidate | null }
      ).candidate;
      if (candidate && this.signaling) {
        const cand =
          typeof candidate.toJSON === "function"
            ? candidate.toJSON()
            : candidate;
        this.signaling.send(
          JSON.stringify({ to: peer.id, type: "candidate", candidate: cand }),
        );
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      const state = pc.connectionState;
      this.log("peer.connectionstate", { clientId: peer.id, state });
      if (
        state === "failed" ||
        state === "closed" ||
        state === "disconnected"
      ) {
        this.closePeer(slot, `connectionState=${state}`);
      }
    });

    // Daemon side is the offerer — we create the DataChannel.
    const dc = pc.createDataChannel("sidecode/v1", { ordered: true });
    slot.dc = dc;
    dc.addEventListener("open", () => this.onDataChannelOpen(slot));
    dc.addEventListener("message", (event) => {
      const data = (event as unknown as { data: unknown }).data;
      this.onDataChannelMessage(slot, data);
    });
    dc.addEventListener("close", () => {
      this.closePeer(slot, "datachannel closed");
    });

    // Create offer, sign the DTLS fingerprint, forward via signaling.
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const sdp = offer.sdp ?? pc.localDescription?.sdp ?? "";
      const fp = extractDtlsFingerprint(sdp);
      const fpSig = cryptoSign(
        null,
        Buffer.from(dtlsFingerprintTranscript(fp)),
        this.identity.privateKey,
      ).toString("base64url");
      this.signaling?.send(
        JSON.stringify({ to: peer.id, type: "offer", sdp, fpSig }),
      );
    } catch (err) {
      this.log("peer.offer.error", {
        clientId: peer.id,
        error: (err as Error).message,
      });
      this.closePeer(slot, "offer failed");
    }
  }

  private async onAnswer(
    fromId: string,
    msg: Record<string, unknown>,
  ): Promise<void> {
    const peer = this.peers.get(fromId);
    if (!peer) return;

    const sdp = typeof msg.sdp === "string" ? msg.sdp : "";
    const fpSigB64 = typeof msg.fpSig === "string" ? msg.fpSig : "";
    if (!sdp || !fpSigB64) {
      this.log("peer.answer.missing_sig", { clientId: peer.clientId });
      this.closePeer(peer, "answer missing fpSig");
      return;
    }

    // Verify the client's signature over the DTLS fingerprint they're
    // committing to. This is the core of the "no MITM via signaling"
    // guarantee — if the signaling worker swapped the answer's
    // fingerprint, the signature here won't match.
    let fp: string;
    try {
      fp = extractDtlsFingerprint(sdp);
    } catch (err) {
      this.log("peer.answer.bad_sdp", {
        clientId: peer.clientId,
        error: (err as Error).message,
      });
      this.closePeer(peer, "answer SDP missing fingerprint");
      return;
    }
    const sigBytes = Buffer.from(fpSigB64, "base64url");
    const ok = cryptoVerify(
      null,
      Buffer.from(dtlsFingerprintTranscript(fp)),
      publicKeyFromB64(peer.clientPubkey),
      sigBytes,
    );
    if (!ok) {
      this.log("peer.answer.bad_sig", { clientId: peer.clientId });
      this.closePeer(peer, "answer fpSig invalid");
      return;
    }

    try {
      await peer.pc.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp }),
      );
    } catch (err) {
      this.log("peer.answer.set_remote_error", {
        clientId: peer.clientId,
        error: (err as Error).message,
      });
      this.closePeer(peer, "setRemoteDescription failed");
    }
  }

  // ─── DataChannel: open + frame dispatch ─────────────────────────

  private onDataChannelOpen(slot: PeerSlot): void {
    // DTLS handshake completed AND we already verified the answer's
    // fpSig against clientPubkey — the channel is now bound to a peer
    // whose identity was pinned by Ed25519. No further handshake.
    slot.authenticated = true;
    if (slot.setupTimeoutId) {
      clearTimeout(slot.setupTimeoutId);
      slot.setupTimeoutId = null;
    }
    this.log("peer.authenticated", {
      clientId: slot.clientId,
      fingerprint: slot.fingerprint,
    });
  }

  private onDataChannelMessage(slot: PeerSlot, data: unknown): void {
    if (!slot.authenticated) return;

    let frame: ClientFrame;
    try {
      const text =
        typeof data === "string"
          ? data
          : new TextDecoder().decode(data as ArrayBuffer);
      let parsed: unknown = JSON.parse(text);
      // Chunked-message reassembly. Chunk envelopes are the transport
      // wrapper around oversized JSON payloads (sender side splits in
      // `send()` below). Intermediate chunks return `null`; only when
      // the last slice arrives do we have a full JSON string to feed
      // into the schema parser.
      if (isChunkEnvelope(parsed)) {
        const assembled = slot.reassembler.push(parsed as ChunkEnvelope);
        if (assembled === null) return;
        parsed = JSON.parse(assembled);
      }
      frame = clientFrame.parse(parsed);
    } catch (err) {
      this.log("peer.bad_frame", {
        clientId: slot.clientId,
        error: (err as Error).message,
      });
      // We don't kill the channel on bad frame — the protocol doesn't
      // require it, and a malformed message from an authenticated peer
      // is more likely a bug than an attack. Reconsider if abuse
      // patterns appear.
      return;
    }

    // ─── Wire-version handshake gate ─────────────────────────────────
    // `hello` from iOS is the only frame valid before versionVerified
    // flips. The protocol package's `isProtocolCompatible` owns the rule
    // (same minor for 0.x, same major for ≥1.x). Mismatch → send
    // `incompatible_protocol` error + close the peer.
    if (frame.type === "hello") {
      if (slot.versionVerified) {
        // Re-hello shouldn't happen; ignore silently to keep state
        // machine simple.
        return;
      }
      if (!isProtocolCompatible(frame.protocolVersion)) {
        this.log("peer.version_mismatch", {
          clientId: slot.clientId,
          clientProtocolVersion: frame.protocolVersion,
          daemonProtocolVersion: PROTOCOL_VERSION,
        });
        this.send(slot, {
          type: "error",
          code: "incompatible_protocol",
          message: `client protocol ${frame.protocolVersion} is not compatible with daemon ${PROTOCOL_VERSION}`,
          // Structured copy of our version so iOS can tell WHICH side is
          // outdated (`outdatedSide`) and name it in the error copy.
          protocolVersion: PROTOCOL_VERSION,
        });
        this.closePeer(slot, "incompatible wire protocol");
        return;
      }
      slot.versionVerified = true;
      this.send(slot, {
        type: "server_info",
        protocolVersion: PROTOCOL_VERSION,
      });
      this.log("peer.version_ok", {
        clientId: slot.clientId,
        protocolVersion: frame.protocolVersion,
      });
      return;
    }

    if (!slot.versionVerified) {
      // Any non-hello frame before the handshake completes is a protocol
      // error. We reply with `incompatible_protocol` and close — a well-
      // behaved client would never get here, so this is mostly diagnostic
      // for a buggy/malicious peer.
      this.log("peer.pre_hello_frame", {
        clientId: slot.clientId,
        frameType: frame.type,
      });
      this.send(slot, {
        type: "error",
        code: "incompatible_protocol",
        message: "hello required before any other frame",
      });
      this.closePeer(slot, "frame before hello");
      return;
    }

    if (frame.type === "ping") {
      this.send(slot, { type: "pong", t: Date.now(), echoT: frame.t });
      return;
    }

    const handler = this.commandHandler;
    if (!handler) {
      this.log("peer.unhandled", {
        clientId: slot.clientId,
        frameType: frame.type,
      });
      return;
    }
    const cmd = frame as Command;
    const ctx: CommandContext = {
      send: (f) => this.send(slot, f),
      fingerprint: slot.fingerprint,
      onDisconnect: (cb) => slot.disconnectCallbacks.push(cb),
      state: slot.scratch,
    };
    Promise.resolve()
      .then(() => handler(cmd, ctx))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.log("peer.handler_error", {
          clientId: slot.clientId,
          frameType: frame.type,
          error: message,
        });
        const requestId =
          "requestId" in cmd
            ? (cmd as { requestId?: string }).requestId
            : undefined;
        this.send(slot, {
          type: "error",
          requestId,
          code: "internal",
          message: `handler error: ${message}`,
        });
      });
  }

  // ─── Send / close ───────────────────────────────────────────────

  private send(slot: PeerSlot, frame: DaemonFrame): void {
    if (!slot.dc || slot.dc.readyState !== "open") return;
    try {
      // `chunkMessage` yields the original JSON unchanged when it
      // fits the wire limit; only oversized frames get split into
      // envelopes (see chunking.ts). Sending each piece sequentially
      // is safe — DataChannel is `ordered: true` so the receiver
      // sees them in order without us tracking indices.
      const json = JSON.stringify(frame);
      for (const piece of chunkMessage(json)) {
        slot.dc.send(piece);
      }
    } catch (err) {
      this.log("peer.send.error", {
        clientId: slot.clientId,
        error: (err as Error).message,
      });
    }
  }

  private closePeer(slot: PeerSlot, reason: string): void {
    if (!this.peers.has(slot.clientId)) return;
    if (slot.setupTimeoutId) {
      clearTimeout(slot.setupTimeoutId);
      slot.setupTimeoutId = null;
    }
    for (const cb of slot.disconnectCallbacks) {
      try {
        cb();
      } catch (err) {
        this.log("peer.cleanup_error", {
          clientId: slot.clientId,
          error: (err as Error).message,
        });
      }
    }
    try {
      slot.dc?.close();
    } catch {
      // ignore
    }
    try {
      slot.pc.close();
    } catch {
      // ignore
    }
    this.peers.delete(slot.clientId);
    this.log("peer.closed", { clientId: slot.clientId, reason });
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private knownClientByPubkey(pubkey: string) {
    for (const c of this.knownClients.list()) {
      if (c.publicKeyB64 === pubkey) return c;
    }
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function fingerprintFromPubkey(publicKeyB64: string): string {
  // Same derivation as identity.ts: sha256(raw pubkey bytes), first 16 hex.
  return createHash("sha256")
    .update(Buffer.from(publicKeyB64, "base64url"))
    .digest("hex")
    .slice(0, 16);
}
