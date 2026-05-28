import * as ed25519 from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  type ChunkEnvelope,
  ChunkReassembler,
  chunkMessage,
  type DirectoryEntry,
  decodePairOfferPayload,
  type EventDelta,
  type GitStatus,
  type ImageAttachment,
  isChunkEnvelope,
  isProtocolCompatible,
  type ModelEntry,
  PAIR_OFFER_VERSION,
  PROTOCOL_VERSION,
  type TimelineItem,
  type TurnUsage,
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
 *
 * `cursor` is the wire cursor for this event — passed through verbatim
 * so the facade can use it as the resume hint on the next reconnect
 * without re-deriving from an event count (which would break if the
 * daemon ever batched or skipped cursors).
 */
type EventCallback = (cursor: number, delta: EventDelta) => void;
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

/**
 * Single underlying WebRTC + RPC transport for the daemon connection.
 * Throwaway: one instance per successful WebRTC handshake; replaced
 * wholesale on every reconnect. Consumers should NEVER reference this
 * directly — they bind to the stable `DaemonClient` facade below, which
 * holds a `Transport | null` ref and swaps it out across reconnects.
 *
 * Renamed from the old public `DaemonClient` class on the WebRTC facade
 * refactor (see project_v0_webrtc_pivot.md + the durable-streams /
 * Centrifuge inspiration). The static `pair` / `reconnect` factories
 * stay here — Provider wires `Transport.reconnect(...)` → facade._attach.
 */
export class Transport {
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
  ): Promise<Transport> {
    const client = await Transport.connect(
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
  ): Promise<Transport> {
    return Transport.connect(identity, daemon.daemonIdentityPublicKey);
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
  ): Promise<Transport> {
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
              const client = new Transport(signaling, peer, dc, pending);
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
   * List one level of a directory on the daemon machine for the iOS
   * cwd / file picker. `path` accepts an absolute path or "~" / "~/...";
   * server expands. Options:
   *   - `includeFiles`: surface file entries (default: folders only)
   *   - `includeHidden`: surface dotfile entries (default: hidden)
   *
   * V0 leaves file `size` / `modifiedAt` undefined even when
   * `includeFiles=true` — the per-entry stat path is deferred. See
   * daemon's listDirectory handler header for the rationale.
   */
  async listDirectory(
    path: string,
    opts: { includeFiles?: boolean; includeHidden?: boolean } = {},
  ): Promise<{
    path: string;
    parent: string | null;
    entries: DirectoryEntry[];
  }> {
    const requestId = Crypto.randomUUID();
    const frame: { type: string; requestId: string } & Record<string, unknown> =
      { type: "listDirectory", requestId, path };
    if (opts.includeFiles !== undefined) frame.includeFiles = opts.includeFiles;
    if (opts.includeHidden !== undefined)
      frame.includeHidden = opts.includeHidden;
    const res = (await this.request(frame)) as {
      path: string;
      parent: string | null;
      entries: DirectoryEntry[];
    };
    return res;
  }

  /**
   * Bootstrap RPC for the picker — one call returns daemon machine's
   * HOME + (if they exist) Desktop / Documents shortcut paths +
   * recent-cwd candidates aggregated from session history. Callers
   * typically wrap in react-query with a long staleTime.
   */
  async getFilesystemRoots(): Promise<{
    home: string;
    desktop?: string;
    documents?: string;
    recentCwds: { path: string; lastUsedAt: string }[];
  }> {
    const requestId = Crypto.randomUUID();
    return (await this.request({
      type: "getFilesystemRoots",
      requestId,
    })) as {
      home: string;
      desktop?: string;
      documents?: string;
      recentCwds: { path: string; lastUsedAt: string }[];
    };
  }

  /**
   * Bootstrap RPC for the model picker — one call returns daemon's
   * curated (non-deprecated) model list with display labels +
   * default marker. Cache lifetime is the daemon lifetime (table is
   * hardcoded), so callers should set a long staleTime in react-query.
   */
  async getModels(): Promise<ModelEntry[]> {
    const requestId = Crypto.randomUUID();
    const res = (await this.request({
      type: "getModels",
      requestId,
    })) as { models: ModelEntry[] };
    return res.models;
  }

  /**
   * Subscribe to a session's live event stream. Low-level RPC — the
   * facade (`DaemonClient`) wraps this with the registry that handles
   * cross-reconnect resumption + state machine; consumers should call
   * `daemonClient.subscribe(...)`, not this directly.
   *
   * `opts.sinceCursor` + `opts.sinceEpoch` are the resume hints. Pass
   * both when the caller has previously subscribed to this session on
   * THIS process (= within the same DaemonClient facade lifetime) and
   * wants the daemon to skip the JSONL re-read and only fill the gap.
   * Daemon falls back to a full snapshot transparently if the epoch
   * doesn't match or the ring buffer evicted the gap events — caller
   * detects via `recovered: false` on the response.
   *
   * Returns the daemon's response (settled / cursor / epoch / recovered
   * / initialUsage) plus the `unsubscribe` thunk. The thunk is
   * identity-checked: a stale cleanup after a quick remount won't
   * clobber the new subscription.
   */
  async subscribe(
    sessionId: string,
    onEvent: EventCallback,
    opts: { sinceCursor?: number; sinceEpoch?: string } = {},
  ): Promise<{
    settled: TimelineItem[];
    cursor: number;
    epoch: string;
    recovered: boolean;
    /** Usage seed for the context meter — daemon extracts from the
     *  last assistant message's raw envelope so the meter has a number
     *  on resume. Undefined for fresh sessions, tool-only last turns,
     *  AND for the warm path (recovered:true) where the client already
     *  has the latest usage from the live stream. */
    initialUsage?: TurnUsage;
    unsubscribe: () => Promise<void>;
  }> {
    this.eventCallbacks.set(sessionId, onEvent);
    let res: {
      settled: TimelineItem[];
      cursor: number;
      epoch: string;
      recovered: boolean;
      initialUsage?: TurnUsage;
    };
    try {
      const requestId = Crypto.randomUUID();
      const frame: {
        type: string;
        requestId: string;
        sessionId: string;
        sinceCursor?: number;
        sinceEpoch?: string;
      } = { type: "subscribe", requestId, sessionId };
      if (opts.sinceCursor !== undefined) frame.sinceCursor = opts.sinceCursor;
      if (opts.sinceEpoch !== undefined) frame.sinceEpoch = opts.sinceEpoch;
      res = (await this.request(frame)) as {
        settled: TimelineItem[];
        cursor: number;
        epoch: string;
        recovered: boolean;
        initialUsage?: TurnUsage;
      };
    } catch (err) {
      if (this.eventCallbacks.get(sessionId) === onEvent) {
        this.eventCallbacks.delete(sessionId);
      }
      throw err;
    }
    return {
      settled: res.settled,
      cursor: res.cursor,
      epoch: res.epoch,
      recovered: res.recovered,
      initialUsage: res.initialUsage,
      unsubscribe: () => this.unsubscribeOwned(sessionId, onEvent),
    };
  }

  /**
   * Send a user prompt into a session. `cwd` REQUIRED on the first
   * sendPrompt for an iOS-created session (no JSONL yet); ignored for
   * resume. Daemon validates and may reply with
   * `{ type: "error", code: "invalid_message" }` for missing-cwd.
   *
   * `images` carry compressed base64 JPEG/PNG attachments — protocol
   * schema is `{ data, mediaType }`. Daemon wraps these into Anthropic
   * `ImageBlockParam`s ahead of the text block when calling the SDK.
   * Empty / missing array sends a text-only prompt.
   *
   * `model` carries the input-bar picker's current selection. Daemon
   * uses it as the SDK `query()` initial option on FIRST ensureSessionLoop
   * (create path, or resume after a runtime respawn). Mid-session apply
   * is owned by `setSessionSelection` (pick-time RPC). iOS should still
   * pass the current selection on every sendPrompt so daemon-restart
   * recoveries inherit it cleanly.
   *
   * Argument shape is an options object — cwd/images/model grew past
   * the comfortable positional-parameter threshold.
   */
  async sendPrompt(opts: {
    sessionId: string;
    text: string;
    cwd?: string;
    images?: ImageAttachment[];
    model?: string;
  }): Promise<void> {
    const requestId = Crypto.randomUUID();
    const frame: { type: string; requestId: string } & Record<string, unknown> =
      {
        type: "sendPrompt",
        requestId,
        sessionId: opts.sessionId,
        text: opts.text,
      };
    if (opts.cwd !== undefined) frame.cwd = opts.cwd;
    if (opts.images !== undefined && opts.images.length > 0) {
      frame.images = opts.images;
    }
    if (opts.model !== undefined) frame.model = opts.model;
    await this.request(frame);
  }

  /**
   * Pick-time commit of the input-bar's model selection. Daemon
   * applies to the live SDK query via `applyFlagSettings({ model })`,
   * then writes the new model into sidecode metadata if that call
   * succeeds. Throws on apply failure — callers (typically a TanStack
   * Query mutation with onError rollback) revert the optimistic picker
   * update.
   *
   * Omitted model is a no-op (defensive — picker shouldn't fire this).
   */
  async setSessionSelection(opts: {
    sessionId: string;
    model?: string;
  }): Promise<void> {
    const requestId = Crypto.randomUUID();
    const frame: { type: string; requestId: string } & Record<string, unknown> =
      {
        type: "setSessionSelection",
        requestId,
        sessionId: opts.sessionId,
      };
    if (opts.model !== undefined) frame.model = opts.model;
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
        frame.delta !== undefined &&
        typeof (frame as { cursor?: unknown }).cursor === "number"
      ) {
        const cb = this.eventCallbacks.get(frame.sessionId);
        if (cb) cb((frame as { cursor: number }).cursor, frame.delta);
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

// ─── Subscription registry types ────────────────────────────────────────

/**
 * Payload delivered to `onSubscribed`. The fields distinguish the two
 * RPC outcomes:
 *
 *   - `recovered: false` — daemon returned a full snapshot. Consumer
 *     MUST truncate its collection and ingest `settled` from scratch.
 *     Fires on first subscribe of a session, on app cold start, and on
 *     reconnect when the daemon couldn't serve incrementally (epoch
 *     mismatch or sinceCursor predates ring).
 *   - `recovered: true` — daemon served incrementally. `settled` is
 *     empty; consumer keeps its existing collection state and the
 *     facade will replay events (`onEvent`) for the gap between the
 *     last seen cursor and the daemon's current cursor.
 *
 * `initialUsage` is only present on cold-path responses — daemon
 * skips it on warm path because the consumer's live `latestUsage`
 * state is already current.
 */
export interface SubscriptionAttached {
  recovered: boolean;
  settled: TimelineItem[];
  cursor: number;
  initialUsage?: TurnUsage;
}

/**
 * Opaque per-session subscription handle owned by the `DaemonClient`
 * facade. Public surface is just `unsubscribe()` — everything else is
 * internal bookkeeping for the registry's replay-on-reconnect logic.
 *
 * State fields are all leading-underscored to signal "facade-only".
 * No public observable state machine: V0 consumers don't need to
 * render "subscribing" / "catching up" / "errored" badges — the
 * useDaemonClient hook's `connectionStatus` covers the offline UX.
 * If/when we add per-subscription error UI, expose what's needed at
 * that point — adding fields is non-breaking.
 *
 * Lifecycle: created by `daemonClient.subscribe(...)`, lives across
 * any number of transport reconnects (re-attached by the facade's
 * registry replay), terminates on `.unsubscribe()`.
 */
export class Subscription {
  /** Internal state for race detection during attach/detach handoffs
   *  — NOT public observable state. Three values:
   *    - "subscribing": registered but no in-flight subscribe RPC has
   *      resolved on the current transport (or no transport attached)
   *    - "subscribed": last subscribe RPC resolved; live events flow
   *    - "unsubscribed": terminal; .unsubscribe() removed from registry
   *  Used only to detect "consumer raced us during an await" — see
   *  the cast sites in attachSubscription. */
  _state: "subscribing" | "subscribed" | "unsubscribed" = "subscribing";
  /** Last cursor consumed via onEvent OR set from a cold-path
   *  response. Passed back as `sinceCursor` on the next attach.
   *  Null until the first successful subscribe response. */
  _cursor: number | null = null;
  /** Daemon epoch from the most recent subscribe response. Passed
   *  back as `sinceEpoch` on the next attach. Null until first
   *  successful attach. */
  _epoch: string | null = null;
  /** Transport-level unsubscribe thunk for the current attachment, or
   *  null when no transport is attached. */
  _currentUnsubscribe: (() => Promise<void>) | null = null;

  constructor(
    readonly cliSessionId: string,
    readonly callbacks: {
      onEvent: (delta: EventDelta) => void;
      onSubscribed: (info: SubscriptionAttached) => void;
    },
    private readonly facadeUnsubscribe: (sub: Subscription) => Promise<void>,
  ) {}

  /** Consumer entrypoint. Removes from facade registry; if a transport
   *  is currently attached, sends the unsubscribe RPC. Idempotent. */
  async unsubscribe(): Promise<void> {
    if (this._state === "unsubscribed") return;
    await this.facadeUnsubscribe(this);
  }
}

// ─── DaemonClient facade ────────────────────────────────────────────────

/**
 * Stable, long-lived public client. The Provider instantiates ONE per
 * app lifetime and consumers bind to it; the underlying `Transport`
 * comes and goes on WebRTC reconnects without changing this object's
 * identity.
 *
 * Why this layer exists:
 *   - Removes the `client: DaemonClient | null` flicker every consumer
 *     used to gate on (the brief null between `_detachTransport` and
 *     the next `_attachTransport`). Consumers see a steady reference;
 *     RPCs await `readyPromise` internally.
 *   - Owns the per-session subscription registry. On every reconnect
 *     the facade replays the registry against the new Transport with
 *     each sub's `_cursor` + `_epoch` as resume hints — daemon serves
 *     incrementally when it can, falls back to a fresh snapshot
 *     transparently when it can't. Consumer's onEvent / onSubscribed
 *     fire continuously; the `recovered: false` flag on a re-attach
 *     tells the consumer "your collection is stale, rebuild it."
 *
 * Non-subscribe RPCs (`listSessions`, `getModels`, etc.) are thin
 * pass-throughs that `await this.readyPromise` then dispatch to the
 * current transport. If a transport drops while a pass-through is
 * in-flight, the request rejects with "daemon connection closed" —
 * caller handles via react-query's retry or visible error state, same
 * as today.
 *
 * Consumers holding non-facade-managed subscriptions (`subscribeGitStatus`
 * today — git status doesn't get the auto-resume treatment because it's
 * inherently per-cwd and cheap to re-fetch) read `connectionStatus`
 * from `useDaemonClient` and put IT in their useEffect deps. A
 * "offline" → "online" transition fires the effect's cleanup + re-run,
 * which lands a fresh subscribe on the new transport. No facade-side
 * machinery needed for this case.
 *
 * Lifecycle calls are leading-underscored — Provider is the only
 * legitimate caller. External consumers MUST NOT touch them.
 */
export class DaemonClient {
  private transport: Transport | null = null;
  private readyPromise: Promise<Transport>;
  private resolveReady!: (t: Transport) => void;
  private readonly subs = new Set<Subscription>();

  constructor() {
    this.readyPromise = new Promise((r) => {
      this.resolveReady = r;
    });
  }

  /** Provider hook. Called after each successful Transport handshake.
   *  Re-resolves the readyPromise, then replays every registered
   *  subscription against the new transport (in parallel, with per-sub
   *  try/catch for error isolation). */
  _attachTransport(t: Transport): void {
    this.transport = t;
    this.resolveReady(t);
    // Replay every active subscription. Parallel + isolated — a single
    // session's subscribe RPC failure must not stall the rest.
    for (const sub of this.subs) {
      void this.attachSubscription(t, sub);
    }
  }

  /** Provider hook. Called BEFORE the transport is closed (so the
   *  pending readyPromise gets re-armed before any RPC tries to
   *  resolve against a dead handle). The transport's own teardown
   *  cleans up its eventCallbacks map; we just clear our local
   *  unsubscribe thunks (they're tied to that dead map). */
  _detachTransport(): void {
    this.transport = null;
    // Re-arm readyPromise so any in-flight `await` blocks until the
    // next _attachTransport.
    this.readyPromise = new Promise((r) => {
      this.resolveReady = r;
    });
    for (const sub of this.subs) {
      sub._currentUnsubscribe = null;
      // Flag for race-detection in the next attach attempt — see the
      // cast sites in attachSubscription. Won't fire if sub is already
      // unsubscribed (idempotent).
      if (sub._state === "subscribed") sub._state = "subscribing";
    }
  }

  private async attachSubscription(t: Transport, sub: Subscription): Promise<void> {
    if (sub._state === "unsubscribed") return;
    sub._state = "subscribing";

    const opts =
      sub._cursor !== null && sub._epoch !== null
        ? { sinceCursor: sub._cursor, sinceEpoch: sub._epoch }
        : {};

    try {
      const result = await t.subscribe(
        sub.cliSessionId,
        // Wrap onEvent to update the resume cursor with the wire cursor
        // verbatim — single source of truth, robust against future
        // daemon-side batching / skipping.
        (cursor, delta) => {
          sub._cursor = cursor;
          sub.callbacks.onEvent(delta);
        },
        opts,
      );
      // TS narrows `sub._state` to "subscribing" based on the assignment
      // at the top of this function, but consumer can call .unsubscribe()
      // during the await — re-cast to acknowledge the mutability.
      if ((sub._state as Subscription["_state"]) === "unsubscribed") {
        // Consumer raced us — drop the freshly-attached handle.
        void result.unsubscribe().catch(() => {});
        return;
      }
      sub._epoch = result.epoch;
      sub._currentUnsubscribe = result.unsubscribe;
      sub._state = "subscribed";
      // _cursor semantics = "highest cursor consumer has seen".
      //   - Cold (recovered:false): settled[] in onSubscribed covers
      //     everything up to result.cursor — record that as our high
      //     water so the next reconnect resumes from here.
      //   - Warm (recovered:true): leave _cursor alone (set by the
      //     last onEvent on the prior attach, = sinceCursor we sent).
      //     The replay events about to arrive will advance it forward.
      if (!result.recovered) sub._cursor = result.cursor;
      sub.callbacks.onSubscribed({
        recovered: result.recovered,
        settled: result.settled,
        cursor: result.cursor,
        initialUsage: result.initialUsage,
      });
    } catch {
      // Transport-level failure (RPC reject, transport closed
      // mid-await). Leave sub._state as "subscribing" — the next
      // _attachTransport will retry. Swallowed silently because the
      // offline UX is owned by connectionStatus, not per-sub error
      // surface; we don't want to spam console with expected errors
      // during reconnect storms.
    }
  }

  /**
   * Subscribe to a session's live event stream with auto-resume across
   * transport reconnects. Returns a `Subscription` handle whose only
   * public method is `.unsubscribe()`. Safe to call at any time — if
   * the underlying transport isn't up yet, the facade queues the
   * subscribe to fire on the next `_attachTransport`.
   *
   * `onSubscribed.recovered === false` is the consumer's signal to
   * truncate its local cache and ingest the response's `settled[]`
   * fresh — happens on first subscribe AND on reconnect when the
   * daemon couldn't serve incrementally (epoch mismatch / cursor
   * predates ring). `recovered === true` means the consumer's
   * existing collection is still valid; subsequent `onEvent` calls
   * fill the gap.
   */
  subscribe(
    cliSessionId: string,
    callbacks: {
      onEvent: (delta: EventDelta) => void;
      onSubscribed: (info: SubscriptionAttached) => void;
    },
  ): Subscription {
    const sub = new Subscription(
      cliSessionId,
      callbacks,
      (s) => this.removeSubscription(s),
    );
    this.subs.add(sub);
    if (this.transport !== null) {
      void this.attachSubscription(this.transport, sub);
    }
    return sub;
  }

  private async removeSubscription(sub: Subscription): Promise<void> {
    sub._state = "unsubscribed";
    this.subs.delete(sub);
    const unsub = sub._currentUnsubscribe;
    sub._currentUnsubscribe = null;
    if (unsub !== null) {
      try {
        await unsub();
      } catch {
        // Transport may already be dead; ignore.
      }
    }
  }

  // ─── Pass-through RPCs (await readyPromise → dispatch) ────────────

  async listSessions(dir?: string): Promise<unknown[]> {
    const t = await this.readyPromise;
    return t.listSessions(dir);
  }

  async listDirectory(
    path: string,
    opts?: { includeFiles?: boolean; includeHidden?: boolean },
  ): Promise<{
    path: string;
    parent: string | null;
    entries: DirectoryEntry[];
  }> {
    const t = await this.readyPromise;
    return t.listDirectory(path, opts);
  }

  async getFilesystemRoots(): Promise<{
    home: string;
    desktop?: string;
    documents?: string;
    recentCwds: { path: string; lastUsedAt: string }[];
  }> {
    const t = await this.readyPromise;
    return t.getFilesystemRoots();
  }

  async getModels(): Promise<ModelEntry[]> {
    const t = await this.readyPromise;
    return t.getModels();
  }

  async sendPrompt(opts: {
    sessionId: string;
    text: string;
    cwd?: string;
    images?: ImageAttachment[];
    model?: string;
  }): Promise<void> {
    const t = await this.readyPromise;
    return t.sendPrompt(opts);
  }

  async setSessionSelection(opts: {
    sessionId: string;
    model?: string;
  }): Promise<void> {
    const t = await this.readyPromise;
    return t.setSessionSelection(opts);
  }

  async interrupt(sessionId: string): Promise<void> {
    const t = await this.readyPromise;
    return t.interrupt(sessionId);
  }

  /**
   * Per-cwd git status subscribe. Pass-through to the current
   * transport — NO facade-managed registry (git status is cheap to
   * re-fetch and per-cwd subscriptions don't have the same continuity
   * requirements as transcript). Consumers re-subscribe on transport
   * swap by including `daemonClient.connectionEpoch` in their useEffect
   * deps.
   */
  async subscribeGitStatus(
    cwd: string,
    onUpdate: (status: GitStatus) => void,
  ): Promise<{
    status: GitStatus;
    unsubscribe: () => Promise<void>;
  }> {
    const t = await this.readyPromise;
    return t.subscribeGitStatus(cwd, onUpdate);
  }
}

// Shared-connection orchestration lives in `daemon-client-context.tsx` —
// this module exports primitives (Transport class + DaemonClient facade
// + Subscription handle + pair / reconnect / store helpers); the Context
// owns the single live DaemonClient + its current Transport.
