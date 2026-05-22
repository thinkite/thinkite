import {
  createHash,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  type ClientFrame,
  clientFrame,
  type Command,
  type DaemonFrame,
  dtlsFingerprintTranscript,
  extractDtlsFingerprint,
} from "@sidecodeapp/protocol";
import {
  RTCIceCandidate,
  RTCPeerConnection,
  RTCSessionDescription,
} from "node-datachannel/polyfill";
import PartySocket from "partysocket";
import type { Identity } from "./identity.js";
import type { KnownClients } from "./known-clients.js";
import { publicKeyFromB64 } from "./identity.js";
import type { CommandContext, CommandHandler } from "./ws-server.js";

/**
 * P2.7c: WebRTC-DataChannel transport with **DTLS-fingerprint-pinned identity**.
 *
 * Replaces both `WebSocketServer`'s transport AND its 4-frame
 * application-layer handshake (client.hello / server.hello /
 * client.auth / server.ready). The previous design ran a full
 * transcript-signing handshake inside the DataChannel — necessary when
 * the transport itself had no E2EE-bound identity (LAN WebSocket). With
 * WebRTC the cleaner place to bind identity is at the DTLS layer:
 *
 *   1. Daemon creates offer; SDP contains an ephemeral DTLS cert
 *      fingerprint.
 *   2. Daemon signs that fingerprint under a domain tag with its
 *      long-lived Ed25519 key and forwards { sdp, fpSig } via signaling.
 *   3. Client (knowing daemon's pubkey from the QR) verifies fpSig
 *      against the fingerprint it sees in the received SDP. If a
 *      malicious signaling worker had swapped the fingerprint, the
 *      verification fails — even before DTLS handshake starts.
 *   4. Client mirrors the same fp-sign step in its answer.
 *   5. Daemon verifies the answer signature against the client's known
 *      pubkey (looked up in `known_clients.json` via the pubkey the
 *      client self-declared on the signaling side).
 *   6. DTLS handshake completes — both peers now have a session bound
 *      to identities verified out-of-band (QR for daemon → client,
 *      pair flow for client → daemon).
 *   7. DataChannel opens. Any frame received on it is implicitly from
 *      the authenticated peer; we hand them straight to the
 *      commandHandler. No further handshake steps.
 *
 * Net result: 0 application-layer handshake frames vs the old 4-frame
 * dance. ~300 LOC of pairing.ts becomes vestigial (only `createOffer`
 * for QR generation stays load-bearing).
 *
 * Pair flow (admitting a new client pubkey to known_clients) is
 * deliberately NOT handled here. The signaling layer sees the client's
 * pubkey on `peer.joined`, but accepting that into known_clients is a
 * privileged decision the menubar UI mediates (a runtime "pairing mode"
 * flag, à la Bluetooth / AirDrop). For V0 we pass `isPairing` as an
 * option: when true, unknown pubkeys are admitted; when false, they're
 * silently rejected. Tests default to permissive.
 */

const DEFAULT_SIGNALING_HOST = "signaling.sidecode.app";
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.cloudflare.com:3478" },
];

export interface WebRTCPeerServerOptions {
  /** Daemon's long-lived Ed25519 identity. Signs DTLS fingerprints +
   *  proves daemon-ownership of the room to the signaling worker. */
  identity: Identity;
  /** Source of truth for "which iOS pubkeys is this daemon paired with."
   *  Looked up on every `peer.joined`. */
  knownClients: KnownClients;
  /** Same dispatcher shape WebSocketServer accepts. Invoked once the
   *  DataChannel opens; the connection at that point is fully
   *  authenticated (DTLS fingerprint signature has been verified +
   *  pubkey is in known_clients). */
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
 * Per-peer slot. Vastly simpler than the old `Connection` from
 * ws-server.ts — no auth state machine, no auth timer, no pending
 * sessionId. The "authenticated" boolean flips true once DataChannel
 * opens (which only succeeds after DTLS verifies the signed
 * fingerprint).
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
  private totalAuths = 0;

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

  async start(): Promise<void> {
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

    // Block until the worker sends us the initial `peers` frame — that's
    // our confirmation it accepted the Ed25519 signature in the URL.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("signaling open timeout")),
        10_000,
      );
      const onMessage = (e: MessageEvent) => {
        const text =
          typeof e.data === "string"
            ? e.data
            : new TextDecoder().decode(e.data as ArrayBuffer);
        const msg = JSON.parse(text) as { type: string };
        if (msg.type === "peers") {
          clearTimeout(timeout);
          this.signaling?.removeEventListener("message", onMessage);
          resolve();
        }
      };
      this.signaling?.addEventListener("message", onMessage);
    });
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

  /** Cumulative successful authentications since start(). */
  totalAuthenticatedCount(): number {
    return this.totalAuths;
  }

  /** All peers with an active PeerConnection (any state). Diagnostics. */
  peerCount(): number {
    return this.peers.size;
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
    if (msg.type === "peer.left" && isRecord(msg.peer)) {
      const peer = this.peers.get(String(msg.peer.id ?? ""));
      if (peer) this.closePeer(peer, "peer.left");
      return;
    }
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
      disconnectCallbacks: [],
      scratch: new Map(),
    };
    this.peers.set(peer.id, slot);

    pc.addEventListener("icecandidate", (event) => {
      const candidate = (
        event as unknown as { candidate?: RTCIceCandidate | null }
      ).candidate;
      if (candidate && this.signaling) {
        const cand =
          typeof candidate.toJSON === "function" ? candidate.toJSON() : candidate;
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
    this.totalAuths += 1;
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
      frame = clientFrame.parse(JSON.parse(text));
    } catch (err) {
      this.log("peer.bad_frame", {
        clientId: slot.clientId,
        error: (err as Error).message,
      });
      // We don't kill the channel on bad frame — the protocol doesn't
      // require it, and a malformed message from an authenticated peer
      // is more likely a bug than an attack. Match ws-server's old
      // behavior was to close; here we just drop. Reconsider if abuse
      // patterns appear.
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
      slot.dc.send(JSON.stringify(frame));
    } catch (err) {
      this.log("peer.send.error", {
        clientId: slot.clientId,
        error: (err as Error).message,
      });
    }
  }

  private closePeer(slot: PeerSlot, reason: string): void {
    if (!this.peers.has(slot.clientId)) return;
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
