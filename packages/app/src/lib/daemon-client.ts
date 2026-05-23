import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  type ChunkEnvelope,
  ChunkReassembler,
  chunkMessage,
  decodePairOfferPayload,
  type EventDelta,
  type GitStatus,
  isChunkEnvelope,
  isProtocolCompatible,
  PAIR_OFFER_VERSION,
  PROTOCOL_VERSION,
  type TimelineItem,
} from "@sidecodeapp/protocol";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { base64UrlToBytes } from "./base64";
import type { ClientIdentity } from "./identity";
import { SignalingClient, type SignalingPeer } from "./signaling-client";
import { WebRTCPeer } from "./webrtc-peer";

// SecureStore restricts keys to [A-Za-z0-9._-] — no slashes / colons. Bump
// the trailing version when the persisted shape changes — older entries
// with a different shape become unreadable, the consumer falls into the
// `unpaired` state, and the user re-pairs cleanly.
//
// v2 → v3: WebRTC pivot. `addresses[]` is gone (signaling worker handles
// discovery), `fingerprint` is now derived from pubkey on read instead of
// persisted. PairedDaemon shrank to `{ daemonIdentityPublicKey, serviceName }`.
const PAIRED_STORE_KEY = "sidecode_paired_daemon_v3";

/**
 * What we save after a successful first pair so subsequent launches can
 * reconnect without re-scanning a QR.
 *
 * Post-WebRTC pivot, this is just the daemon's pubkey (= signaling room +
 * fpSig verify key) plus the display label. `fingerprint` is derived from
 * pubkey via `sha256(...).slice(0, 16)` whenever the UI needs it.
 */
export interface PairedDaemon {
  daemonIdentityPublicKey: string; // base64url
  serviceName: string;
}

export interface PairOffer {
  v: number;
  daemonIdentityPublicKey: string;
  serviceName: string;
}

/** Derive the 16-hex-char daemon fingerprint from its base64url pubkey.
 *  Matches the daemon-side derivation in identity.ts. */
export function fingerprintFromPubkey(daemonIdentityPublicKey: string): string {
  const raw = base64UrlToBytes(daemonIdentityPublicKey);
  const hash = sha256(raw);
  let hex = "";
  for (let i = 0; i < hash.length; i += 1) {
    hex += hash[i].toString(16).padStart(2, "0");
  }
  return hex.slice(0, 16);
}

/**
 * Decode a pair.offer payload (the base64url string from a QR / dev paste).
 *
 * Wire format is base64url of JSON with one-letter keys. The encoding +
 * key-shortening both live in the protocol package; iOS receives the
 * verbose PairOffer shape ready to use.
 */
export function decodePairOffer(payload: string): PairOffer {
  const offer = decodePairOfferPayload(payload);
  if (offer.v !== PAIR_OFFER_VERSION) {
    throw new Error(
      `Pair code is from a different sidecode version (got v=${offer.v}, expected v=${PAIR_OFFER_VERSION}). Update sidecode on your Mac.`,
    );
  }
  return offer;
}

export async function getPairedDaemon(): Promise<PairedDaemon | null> {
  const raw = await SecureStore.getItemAsync(PAIRED_STORE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PairedDaemon>;
    if (
      typeof parsed.daemonIdentityPublicKey !== "string" ||
      typeof parsed.serviceName !== "string"
    ) {
      return null;
    }
    return parsed as PairedDaemon;
  } catch {
    return null;
  }
}

async function setPairedDaemon(d: PairedDaemon): Promise<void> {
  await SecureStore.setItemAsync(PAIRED_STORE_KEY, JSON.stringify(d));
}

export async function clearPairedDaemon(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRED_STORE_KEY);
}

interface PendingRequest {
  resolve: (frame: unknown) => void;
  reject: (err: Error) => void;
}

/**
 * Per-session callback receiving server-initiated `eventFrame` payloads.
 * Function identity (not just sessionId) determines ownership: stale
 * unsubscribes after a re-subscribe won't clobber the new owner.
 */
type EventCallback = (delta: EventDelta) => void;
type GitStatusCallback = (status: GitStatus) => void;

/**
 * Max time we wait from "start connecting" to "DataChannel open". Covers:
 * signaling open + roster + (daemon mints offer) + ICE gather + DTLS.
 * On a healthy LAN the whole flow completes in <200ms; the slack is
 * for slow ICE gathering on hostile networks (STUN-only today; TURN
 * fallback deferred to sidecodeapp/sidecode#6) and for daemon-side
 * delays admitting an unknown pubkey (pair-window open vs not).
 *
 * If this trips, the UX message blames the most likely cause: the user
 * forgot to open the menubar Pair window on their Mac.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/** Minimal authenticated daemon DataChannel client. One per app launch. */
export class DaemonClient {
  /**
   * Per-session live event callbacks. Set on `subscribe`, cleared on
   * `unsubscribe` (only if the stored cb is still the same identity), and
   * cleared en masse on transport close.
   */
  private readonly eventCallbacks = new Map<string, EventCallback>();
  /**
   * Per-cwd git status callbacks. Same identity-checked lifecycle as
   * `eventCallbacks` but keyed by `cwd` instead of `sessionId` — git
   * watcher state is per-workspace on the daemon, not per-session.
   */
  private readonly gitStatusCallbacks = new Map<string, GitStatusCallback>();
  /**
   * Inbound chunk reassembly buffer. Large daemon frames (e.g. a
   * `subscribe.response` for a long-running session whose settled
   * transcript exceeds the SCTP wire limit) arrive as multiple chunk
   * envelopes; this stitches them back into the original JSON before
   * the regular frame router runs. See `packages/protocol/src/chunking.ts`.
   */
  private readonly reassembler = new ChunkReassembler();

  /**
   * `true` once `close()` has been called by the consumer — distinguishes
   * "user / context tore down the connection" from "transport dropped on
   * its own". Drives whether onUnexpectedClose fires.
   */
  private intentionallyClosed = false;

  /**
   * Optional callback invoked when the transport closes WITHOUT a prior
   * `close()` call. Set by the context provider after a successful pair /
   * reconnect to wire up auto-reconnect.
   */
  private onUnexpectedClose: (() => void) | null = null;

  private constructor(
    private readonly signaling: SignalingClient,
    private readonly peer: WebRTCPeer,
    private readonly dc: RTCDataChannel,
    private readonly pending: Map<string, PendingRequest>,
  ) {}

  /**
   * Register a one-shot handler invoked when the underlying transport
   * drops without an explicit `close()` from the consumer (network blip,
   * daemon crash, ICE timeout, etc.). Call before any await yields after
   * pair / reconnect resolves so the handler is wired before any close
   * can fire.
   */
  setOnUnexpectedClose(cb: (() => void) | null): void {
    this.onUnexpectedClose = cb;
  }

  /**
   * First-time pair via a QR offer. Persists `PairedDaemon` for next
   * launch on success.
   */
  static async pair(
    identity: ClientIdentity,
    offer: PairOffer,
  ): Promise<DaemonClient> {
    const client = await DaemonClient.connect(
      identity,
      offer.daemonIdentityPublicKey,
    );
    await setPairedDaemon({
      daemonIdentityPublicKey: offer.daemonIdentityPublicKey,
      serviceName: offer.serviceName,
    });
    return client;
  }

  /** Reconnect using a previously-paired daemon. */
  static async reconnect(
    identity: ClientIdentity,
    daemon: PairedDaemon,
  ): Promise<DaemonClient> {
    return DaemonClient.connect(identity, daemon.daemonIdentityPublicKey);
  }

  /**
   * The single transport-establishment entry point. Wires SignalingClient
   * + WebRTCPeer together, drives the SDP-fp-pinned WebRTC handshake,
   * AND performs the wire-version handshake (`hello` → `server_info`)
   * over the DataChannel before resolving. Identical for pair AND
   * reconnect — from iOS's POV the two cases differ only in (a) what
   * pubkey we connect to and (b) whether the daemon already knows our
   * pubkey (it admits us anyway when its pair-window-open gate is
   * active).
   *
   * The single timeout (`CONNECT_TIMEOUT_MS`) covers the whole flow:
   * signaling open → offer → ICE/DTLS → DC.open → hello → server_info.
   * On wire-version mismatch the daemon sends an `error` frame with
   * code `incompatible_protocol` then closes; we surface that text to
   * the user via the connect error.
   */
  private static connect(
    identity: ClientIdentity,
    daemonPubkey: string,
  ): Promise<DaemonClient> {
    return new Promise((resolve, reject) => {
      // daemon-side connection ID we learn from `peers` / `peer.joined`,
      // used to address candidate / answer frames back to the daemon.
      let daemonPeerId: string | null = null;
      let settled = false;
      const pending = new Map<string, PendingRequest>();

      const cleanup = () => {
        clearTimeout(timeoutId);
        try {
          peer.close();
        } catch {
          // ignore
        }
        try {
          signaling.close();
        } catch {
          // ignore
        }
      };
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      };

      const timeoutId = setTimeout(() => {
        fail(
          new Error(
            "Couldn't reach Mac. Make sure the Pair window is open on your Mac, then tap Retry.",
          ),
        );
      }, CONNECT_TIMEOUT_MS);

      const peer = new WebRTCPeer({
        signFingerprint: (transcript) => identity.sign(transcript),
        verifyFingerprint: async (transcript, sigB64) => {
          try {
            return await ed25519.verifyAsync(
              base64UrlToBytes(sigB64),
              transcript,
              base64UrlToBytes(daemonPubkey),
            );
          } catch {
            return false;
          }
        },
        onLocalCandidate: (candidate) => {
          if (!daemonPeerId) return;
          signaling.send(daemonPeerId, "candidate", { candidate });
        },
        onDataChannelOpen: (dc) => {
          // DTLS is up — but we haven't done the wire-version handshake
          // yet. Send `hello` and wire a one-shot listener for the daemon
          // reply (`server_info` ok, `error` with code
          // `incompatible_protocol` bad). The promise only resolves when
          // server_info arrives; the outer timeout still covers this leg.
          // The hello listener removes itself on success/fail so it
          // doesn't double-fire alongside `installMessageHandlers`'s
          // listener for subsequent application traffic.
          const dcEv = dc as unknown as {
            addEventListener: (
              event: string,
              handler: (e: unknown) => void,
            ) => void;
            removeEventListener: (
              event: string,
              handler: (e: unknown) => void,
            ) => void;
            send: (s: string) => void;
          };
          const onHelloReply = (event: unknown) => {
            const data = (event as { data: unknown }).data;
            if (typeof data !== "string") return;
            let frame: {
              type?: string;
              code?: string;
              message?: string;
              protocolVersion?: string;
            };
            try {
              frame = JSON.parse(data);
            } catch {
              return;
            }
            if (
              frame.type === "error" &&
              frame.code === "incompatible_protocol"
            ) {
              dcEv.removeEventListener("message", onHelloReply);
              // Keep the daemon's diagnostic text (which version it
              // wanted, which we sent) in a console.warn for debugging;
              // user-facing string is generic + actionable.
              if (frame.message) {
                console.warn(
                  `daemon reported incompatible_protocol: ${frame.message}`,
                );
              }
              fail(
                new Error(
                  "Sidecode on your Mac speaks a different protocol version. Update both the app and the Mac app, then try again.",
                ),
              );
              return;
            }
            if (
              frame.type === "server_info" &&
              typeof frame.protocolVersion === "string"
            ) {
              if (settled) return;
              // Defense in depth: daemon should never advertise an
              // incompatible version in server_info (the protocol pkg's
              // `isProtocolCompatible` is symmetric), but if the rules
              // ever drift asymmetrically we'd rather fail cleanly here
              // than continue and watch frames break in opaque ways.
              if (!isProtocolCompatible(frame.protocolVersion)) {
                dcEv.removeEventListener("message", onHelloReply);
                fail(
                  new Error(
                    "Sidecode on your Mac speaks a different protocol version. Update both the app and the Mac app, then try again.",
                  ),
                );
                return;
              }
              settled = true;
              clearTimeout(timeoutId);
              dcEv.removeEventListener("message", onHelloReply);
              // Signaling has done its job — close to free the worker
              // connection. Trickle ICE candidates after this point are
              // unlikely to arrive (and we don't have a path to relay
              // them anyway); the established DataChannel doesn't depend
              // on it.
              try {
                signaling.close();
              } catch {
                // ignore
              }
              const client = new DaemonClient(signaling, peer, dc, pending);
              client.installMessageHandlers();
              resolve(client);
            }
            // Anything else pre-resolve is unexpected — we wait for the
            // timeout rather than guess at it.
          };
          dcEv.addEventListener("message", onHelloReply);
          try {
            dcEv.send(
              JSON.stringify({
                type: "hello",
                protocolVersion: PROTOCOL_VERSION,
              }),
            );
          } catch (err) {
            dcEv.removeEventListener("message", onHelloReply);
            fail(err instanceof Error ? err : new Error(String(err)));
          }
        },
        onState: (s) => {
          if (s === "failed") {
            fail(
              new Error(
                "WebRTC connection failed (ICE or DTLS). Network or NAT may be blocking peer-to-peer; try again.",
              ),
            );
          }
        },
      });

      const onDaemonAvailable = (daemon: SignalingPeer) => {
        daemonPeerId = daemon.id;
        // Daemon sees `peer.joined` from its side and is responsible for
        // initiating the offer; iOS sits and waits. No-op here.
      };

      const signaling = new SignalingClient({
        daemonPubkey,
        clientPubkey: identity.publicKeyB64,
        onPeers: (peers) => {
          const daemon = peers.find((p) => p.role === "daemon");
          if (daemon) onDaemonAvailable(daemon);
        },
        onPeerJoined: (peer) => {
          if (peer.role === "daemon") onDaemonAvailable(peer);
        },
        onOffer: (from, sdp, fpSig) => {
          daemonPeerId = from;
          void peer
            .handleOffer(sdp, fpSig)
            .then(({ answerSdp, fpSig: ourSig }) => {
              signaling.send(from, "answer", { sdp: answerSdp, fpSig: ourSig });
            })
            .catch((err) => {
              fail(err instanceof Error ? err : new Error(String(err)));
            });
        },
        onCandidate: (_from, candidate) => {
          void peer.addRemoteCandidate(candidate as RTCIceCandidateInit);
        },
        onProtocolError: (reason) => {
          // Worker-level errors (peer_not_found / missing_to / etc.) are
          // logged but don't fail the connect — they're typically benign
          // (e.g. daemon transiently offline so our candidate frame got
          // rejected). The timeout will catch the actual stuck cases.
          console.warn(`signaling protocol error: ${reason}`);
        },
      });
      signaling.connect();
    });
  }

  /**
   * Send `listSessions` and await the matching response (or `error` frame).
   * Pass `dir` to filter to one project; omit for all projects (iOS groups
   * client-side).
   */
  async listSessions(dir?: string): Promise<unknown[]> {
    const requestId = Crypto.randomUUID();
    const frame: { type: string; requestId: string } & Record<string, unknown> =
      { type: "listSessions", requestId };
    if (dir !== undefined) frame.dir = dir;
    const res = (await this.request(frame)) as { sessions: unknown[] };
    return res.sessions;
  }

  /**
   * Fetch a session's full transcript, normalized server-side into
   * `TimelineItem[]` (assistant text / user text / paired tool_call). See
   * Slice D normalization in daemon/src/messages/normalize.ts for the
   * detail shape.
   *
   * No `cwd` arg: the SDK does an all-projects scan to find the JSONL.
   * Cheap (~20 stat calls) and robust against fork sessions where the
   * file location varies between worktree and originCwd project keys.
   */
  async getMessages(cliSessionId: string): Promise<TimelineItem[]> {
    const requestId = Crypto.randomUUID();
    const res = (await this.request({
      type: "getMessages",
      requestId,
      cliSessionId,
    })) as { items: TimelineItem[] };
    return res.items;
  }

  /**
   * Subscribe to a session's live event stream. Returns the settled
   * snapshot at subscribe time, the runtime cursor, and an `unsubscribe`
   * thunk that drops the callback + sends the matching RPC.
   *
   * The callback is invoked once per `eventFrame` for this sessionId.
   * Caller is responsible for applying `EventDelta`s to local state
   * (see `timeline-reducer.ts`).
   *
   * Re-subscribe / re-mount safety: each subscribe gets a unique
   * callback identity, and `unsubscribe` only deletes the registry
   * slot if the stored cb still matches — so a stale cleanup after
   * a quick remount won't clobber the new subscription.
   */
  async subscribe(
    sessionId: string,
    onEvent: EventCallback,
  ): Promise<{
    settled: TimelineItem[];
    cursor: number;
    unsubscribe: () => Promise<void>;
  }> {
    this.eventCallbacks.set(sessionId, onEvent);
    let res: { settled: TimelineItem[]; cursor: number };
    try {
      const requestId = Crypto.randomUUID();
      res = (await this.request({
        type: "subscribe",
        requestId,
        sessionId,
      })) as { settled: TimelineItem[]; cursor: number };
    } catch (err) {
      if (this.eventCallbacks.get(sessionId) === onEvent) {
        this.eventCallbacks.delete(sessionId);
      }
      throw err;
    }
    return {
      settled: res.settled,
      cursor: res.cursor,
      unsubscribe: () => this.unsubscribeOwned(sessionId, onEvent),
    };
  }

  /**
   * Send a user prompt into a session. `cwd` REQUIRED on the first
   * sendPrompt for an iOS-created session (no JSONL yet); ignored for
   * resume. Daemon validates and may reply with
   * `{ type: "error", code: "invalid_message" }` for missing-cwd.
   */
  async sendPrompt(
    sessionId: string,
    text: string,
    cwd?: string,
  ): Promise<void> {
    const requestId = Crypto.randomUUID();
    const frame: { type: string; requestId: string } & Record<string, unknown> =
      {
        type: "sendPrompt",
        requestId,
        sessionId,
        text,
      };
    if (cwd !== undefined) frame.cwd = cwd;
    await this.request(frame);
  }

  /**
   * User pressed stop on the live turn. Targets `runtime.query.interrupt()`
   * on the daemon: cancels the current turn but keeps the session /
   * subprocess alive for follow-up prompts.
   */
  async interrupt(sessionId: string): Promise<void> {
    const requestId = Crypto.randomUUID();
    await this.request({
      type: "interrupt",
      requestId,
      sessionId,
    });
  }

  /**
   * Identity-checked unsubscribe — both the local registry slot AND the
   * RPC are gated on `owner` still matching the stored callback.
   *
   * Why gate the RPC too: in React 19 StrictMode dev, useEffect runs
   * mount → cleanup → mount with the same key. The first mount's
   * subscribe Promise often resolves AFTER the cleanup, by which point
   * the second mount has already registered a new callback (overwriting
   * the slot) and re-sent its own subscribe RPC. If we then send a stale
   * unsubscribe RPC for the first mount, the daemon's per-connection
   * `subs` map maps sessionId → unsubscribe handle for the NEW fanout,
   * so the daemon would tear down the live one. Skipping the RPC when
   * we no longer own the slot defers cleanup to whoever does — they'll
   * either send their own unsubscribe later, or the channel close will
   * release everything at once.
   */
  private async unsubscribeOwned(
    sessionId: string,
    owner: EventCallback,
  ): Promise<void> {
    if (this.eventCallbacks.get(sessionId) !== owner) return;
    this.eventCallbacks.delete(sessionId);
    const requestId = Crypto.randomUUID();
    await this.request({
      type: "unsubscribe",
      requestId,
      sessionId,
    });
  }

  /**
   * Subscribe to live git status for a `cwd`. Returns the initial
   * snapshot together with an `unsubscribe` thunk; subsequent state
   * changes arrive through `onUpdate`. Mirrors the `subscribe` lifecycle
   * exactly — identity-checked cleanup, transport-close clears the map.
   */
  async subscribeGitStatus(
    cwd: string,
    onUpdate: GitStatusCallback,
  ): Promise<{
    status: GitStatus;
    unsubscribe: () => Promise<void>;
  }> {
    this.gitStatusCallbacks.set(cwd, onUpdate);
    let res: { status: GitStatus; cwd: string };
    try {
      const requestId = Crypto.randomUUID();
      res = (await this.request({
        type: "subscribeGitStatus",
        requestId,
        cwd,
      })) as { status: GitStatus; cwd: string };
    } catch (err) {
      if (this.gitStatusCallbacks.get(cwd) === onUpdate) {
        this.gitStatusCallbacks.delete(cwd);
      }
      throw err;
    }
    return {
      status: res.status,
      unsubscribe: () => this.unsubscribeGitStatusOwned(cwd, onUpdate),
    };
  }

  private async unsubscribeGitStatusOwned(
    cwd: string,
    owner: GitStatusCallback,
  ): Promise<void> {
    if (this.gitStatusCallbacks.get(cwd) !== owner) return;
    this.gitStatusCallbacks.delete(cwd);
    const requestId = Crypto.randomUUID();
    await this.request({
      type: "unsubscribeGitStatus",
      requestId,
      cwd,
    });
  }

  close(): void {
    this.intentionallyClosed = true;
    try {
      this.peer.close();
    } catch {
      // already closed
    }
    try {
      this.signaling.close();
    } catch {
      // already closed
    }
  }

  private request(
    frame: { type: string; requestId: string } & Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(frame.requestId, { resolve, reject });
      try {
        // react-native-webrtc's RTCDataChannel.send() takes string |
        // ArrayBuffer | ArrayBufferView; we use string here.
        // `chunkMessage` yields the original JSON for normal-sized
        // commands; only an oversized request (e.g. someone pasting
        // megabytes into a prompt) gets split into envelopes.
        const dcSend = (this.dc as unknown as { send: (s: string) => void })
          .send;
        const json = JSON.stringify(frame);
        for (const piece of chunkMessage(json)) {
          dcSend.call(this.dc, piece);
        }
      } catch (err) {
        this.pending.delete(frame.requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Wire DataChannel.onmessage / onclose handlers. Called by `connect`
   *  exactly once, right after the DC opens. Also swaps the peer's
   *  state listener from connect-time (rejects the connect Promise) to
   *  runtime — once the channel is up, ICE/DTLS keepalive failures
   *  (Mac WiFi off, daemon crash, peer network change) surface as
   *  `failed` or `closed` on the PC. DataChannel.onclose alone is not
   *  enough: many WebRTC stacks only fire it on explicit pc.close(),
   *  so a half-dead PC can sit silent for minutes — settings UI would
   *  keep showing "online" while the connection is dead. */
  private installMessageHandlers(): void {
    this.peer.setOnState((s) => {
      if (s === "failed" || s === "closed") this.onTransportClosed();
    });
    const dcEv = this.dc as unknown as {
      addEventListener: (event: string, handler: (e: unknown) => void) => void;
    };
    dcEv.addEventListener("message", (event) => {
      const data = (event as { data: unknown }).data;
      let text: string;
      if (typeof data === "string") {
        text = data;
      } else {
        // BufferSource — shouldn't happen with our JSON wire, but be
        // permissive in case daemon ever ships binary frames.
        try {
          text = new TextDecoder().decode(data as ArrayBuffer);
        } catch {
          return;
        }
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return; // ignore non-JSON
      }
      // Chunk reassembly. Daemon's `webrtc-peer.send()` splits oversized
      // frames into envelopes (see `packages/protocol/src/chunking.ts`);
      // intermediate pieces return `null` and we wait, the last piece
      // returns the full JSON which we re-parse + route as a normal frame.
      if (isChunkEnvelope(parsed)) {
        const assembled = this.reassembler.push(parsed as ChunkEnvelope);
        if (assembled === null) return;
        try {
          parsed = JSON.parse(assembled);
        } catch {
          return;
        }
      }
      const frame = parsed as {
        type?: string;
        requestId?: string;
        message?: string;
        sessionId?: string;
        delta?: EventDelta;
        cwd?: string;
        status?: GitStatus;
      };
      // Server-initiated event frame (no requestId). Routed by sessionId
      // to the subscribed callback. Unknown sessionId → silently drop
      // (probably a frame for a session we just unsubscribed).
      if (
        frame.type === "event" &&
        typeof frame.sessionId === "string" &&
        frame.delta !== undefined
      ) {
        const cb = this.eventCallbacks.get(frame.sessionId);
        if (cb) cb(frame.delta);
        return;
      }
      // Server-initiated git status update. Routed by `cwd` — multiple
      // subscriptions on different workspaces share one connection.
      if (
        frame.type === "gitStatus" &&
        typeof frame.cwd === "string" &&
        frame.status !== undefined
      ) {
        const cb = this.gitStatusCallbacks.get(frame.cwd);
        if (cb) cb(frame.status);
        return;
      }
      if (!frame.requestId) return;
      const slot = this.pending.get(frame.requestId);
      if (!slot) return;
      this.pending.delete(frame.requestId);
      if (frame.type === "error") {
        slot.reject(new Error(frame.message ?? "daemon error"));
      } else {
        slot.resolve(frame);
      }
    });

    dcEv.addEventListener("close", () => this.onTransportClosed());
  }

  private onTransportClosed(): void {
    const err = new Error("daemon connection closed");
    for (const [, slot] of this.pending) slot.reject(err);
    this.pending.clear();
    this.eventCallbacks.clear();
    this.gitStatusCallbacks.clear();
    if (!this.intentionallyClosed) {
      const cb = this.onUnexpectedClose;
      this.onUnexpectedClose = null;
      cb?.();
    }
  }
}

// Shared-connection orchestration lives in `daemon-client-context.tsx` —
// this module exports primitives (DaemonClient class + pair / reconnect /
// store helpers); the Context owns the single live connection.
