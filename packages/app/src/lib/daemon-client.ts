import { sha256 } from "@noble/hashes/sha2.js";
import {
  type DirectoryEntry,
  decodePairOfferPayload,
  type ForwardPort,
  type GitStatus,
  PAIR_OFFER_VERSION,
} from "@thinkite/protocol";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { base64UrlToBytes } from "./base64";
import type { ClientIdentity } from "./identity";
import { connectIrohWire } from "./iroh-wire";
import {
  helloHandshake,
  type WireDiagnostics,
  type WireTransport,
} from "./wire-transport";

/** Wire diagnostics + connect timings, as served by the facade. */
export interface TransportDiagnostics extends WireDiagnostics {
  /** Wire establishment (QUIC dial incl. discovery + path upgrade). */
  wireMs: number;
  /** hello → server_info round trip on the established wire. */
  helloMs: number;
}

// Re-exported so consumers (daemon-client-context) keep their import
// path; the class itself moved to wire-transport.ts with the handshake
// that throws it.
export { IncompatibleProtocolError } from "./wire-transport";

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
 * Just the daemon's pubkey (== its iroh EndpointId — the dial address)
 * plus the display label. `fingerprint` is derived from pubkey via
 * `sha256(...).slice(0, 16)` whenever the UI needs it.
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
      `Pair code is from a different Thinkite version (got v=${offer.v}, expected v=${PAIR_OFFER_VERSION}). Update Thinkite on your Mac.`,
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

type GitStatusCallback = (status: GitStatus) => void;

/**
 * Max time we wait from "start connecting" to the hello handshake
 * settling. Covers: endpoint bind (first connect only) + relay/pkarr
 * discovery + QUIC dial + direct-path upgrade + hello→server_info.
 * Measured: ~400ms Wi-Fi cold, ~600ms cellular cold, ~20ms hot
 * reconnect; the slack is for hostile networks (relay-only paths) and
 * daemon-side delays admitting an unknown pubkey (pair-window open vs
 * not).
 *
 * If this trips, the UX message blames the most likely cause: the user
 * forgot to open the Pair window in the desktop app on their Mac.
 *
 * Also bounds the boot "Connecting to daemon…" screen before it falls to
 * `offline`; the retry loop covers overflow.
 */
const CONNECT_TIMEOUT_MS = 10_000;

/** User-facing copy when the connect deadline trips — blames the most
 *  likely cause (Pair window closed on the Mac). */
const CONNECT_TIMEOUT_MESSAGE =
  "Couldn't reach Mac. Make sure the Pair window is open on your Mac, then tap Retry.";

/**
 * Application-layer liveness probe. A peer that dies without a close
 * frame (kill -9, power loss, cable pull) is otherwise only detected by
 * the transport's own idle machinery — measured at ~35s on iroh (QUIC
 * default idle timeout, no FFI knob to tune it). A ping every 10s with
 * a 5s pong deadline bounds silent-death detection at ~15s worst case
 * (10.5s measured), and as a side effect keeps QUIC idle timers + NAT
 * mappings warm. Daemon side has answered `ping` with `pong` since the
 * WebRTC era — no daemon change.
 */
const PING_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 5_000;

/**
 * Single underlying wire + RPC transport for the daemon connection.
 * Throwaway: one instance per successful connect; replaced wholesale on
 * every reconnect. Consumers should NEVER reference this directly —
 * they bind to the stable `DaemonClient` facade below, which holds a
 * `Transport | null` ref and swaps it out across reconnects.
 *
 * Renamed from the old public `DaemonClient` class on the facade
 * refactor (see project_v0_webrtc_pivot.md + the durable-streams /
 * Centrifuge inspiration). The static `pair` / `reconnect` factories
 * stay here — Provider wires `Transport.reconnect(...)` → facade._attach.
 */
export class Transport {
  /**
   * Per-cwd git status callbacks. Set on `subscribeGitStatus`, cleared on
   * unsubscribe (only if the stored cb is still the same identity), and
   * cleared en masse on transport close. Keyed by `cwd` — git watcher
   * state is per-workspace on the daemon.
   */
  private readonly gitStatusCallbacks = new Map<string, GitStatusCallback>();
  /**
   * `true` once `close()` has been called by the consumer — distinguishes
   * "user / context tore down the connection" from "transport dropped on
   * its own". Drives whether onUnexpectedClose fires.
   */
  private intentionallyClosed = false;

  /** Liveness probe timers (see PING_INTERVAL_MS). Started by
   *  `installMessageHandlers`, cleared on close/teardown. */
  private pingIntervalId: ReturnType<typeof setInterval> | null = null;
  private pongTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /**
   * Optional callback invoked when the transport closes WITHOUT a prior
   * `close()` call. Set by the context provider after a successful pair /
   * reconnect to wire up auto-reconnect.
   */
  private onUnexpectedClose: (() => void) | null = null;

  private constructor(
    private readonly wire: WireTransport,
    private readonly pending: Map<string, PendingRequest>,
    /** Connect-time measurements (phase-4 panel): wire establishment
     *  and hello handshake durations. */
    private readonly timings: { wireMs: number; helloMs: number },
  ) {}

  /** Live wire diagnostics + connect timings for the Settings panel. */
  transportDiagnostics(): TransportDiagnostics {
    return {
      ...this.wire.diagnostics(),
      wireMs: this.timings.wireMs,
      helloMs: this.timings.helloMs,
    };
  }

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
   * The single transport-establishment entry point: establish the iroh
   * wire, then run the shared wire-version handshake (`hello` →
   * `server_info`) before resolving. Identical for pair AND reconnect — from iOS's POV the
   * two cases differ only in (a) what pubkey we connect to and (b)
   * whether the daemon already knows our pubkey (it admits us anyway
   * when its pair-window-open gate is active).
   *
   * One deadline (`CONNECT_TIMEOUT_MS`) covers the whole flow:
   * establishment → hello → server_info. On wire-version mismatch the
   * daemon sends an `error` frame with code `incompatible_protocol`
   * then closes; `helloHandshake` surfaces that as
   * `IncompatibleProtocolError`.
   */
  private static async connect(
    identity: ClientIdentity,
    daemonPubkey: string,
  ): Promise<Transport> {
    const startedAt = Date.now();
    const deadlineAt = startedAt + CONNECT_TIMEOUT_MS;
    const wire = await connectIrohWire(
      identity,
      daemonPubkey,
      deadlineAt,
      CONNECT_TIMEOUT_MESSAGE,
    );
    const wireMs = Date.now() - startedAt;
    try {
      await helloHandshake(wire, deadlineAt, CONNECT_TIMEOUT_MESSAGE);
    } catch (err) {
      wire.close();
      throw err;
    }
    const helloMs = Date.now() - startedAt - wireMs;
    const client = new Transport(wire, new Map(), { wireMs, helloMs });
    client.installMessageHandlers();
    return client;
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
   * Working-tree diff for `cwd` — the status bar's tap target. One-shot RPC
   * (request/response by requestId), wrapped in react-query by
   * `use-working-tree-diff`. Returns the raw multi-file unified diff matching
   * the bar's `+N -M` (vs the default-branch merge-base, incl untracked).
   */
  async getWorkingTreeDiff(cwd: string): Promise<{
    isRepo: boolean;
    diff: string;
    fileCount: number;
    truncated: boolean;
  }> {
    const requestId = Crypto.randomUUID();
    return (await this.request({
      type: "getWorkingTreeDiff",
      requestId,
      cwd,
    })) as {
      isRepo: boolean;
      diff: string;
      fileCount: number;
      truncated: boolean;
    };
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
   * One-shot git status snapshot for `cwd` — the react-query queryFn
   * counterpart to `subscribeGitStatus`'s change stream. Daemon-side it
   * reuses the per-cwd watcher's cached `refresh()`, so firing it
   * concurrently with subscribe costs at most one git invocation.
   */
  async getGitStatus(cwd: string): Promise<GitStatus> {
    const requestId = Crypto.randomUUID();
    const res = (await this.request({
      type: "getGitStatus",
      requestId,
      cwd,
    })) as { status: GitStatus; cwd: string };
    return res.status;
  }

  /** Every port the Mac's running servers listen on, across projects. */
  async getForwardPorts(): Promise<ForwardPort[]> {
    const res = (await this.request({
      type: "getForwardPorts",
      requestId: Crypto.randomUUID(),
    })) as { ports: ForwardPort[] };
    return res.ports;
  }

  /**
   * Subscribe to live git status for a `cwd` — a PURE change stream (no
   * initial snapshot; fetch that via `getGitStatus`). Subsequent changes
   * arrive through `onUpdate`; returns an `unsubscribe` thunk. Mirrors the
   * identity-checked cleanup; transport close clears the map.
   */
  async subscribeGitStatus(
    cwd: string,
    onUpdate: GitStatusCallback,
  ): Promise<{ unsubscribe: () => Promise<void> }> {
    this.gitStatusCallbacks.set(cwd, onUpdate);
    try {
      const requestId = Crypto.randomUUID();
      await this.request({
        type: "subscribeGitStatus",
        requestId,
        cwd,
      });
    } catch (err) {
      if (this.gitStatusCallbacks.get(cwd) === onUpdate) {
        this.gitStatusCallbacks.delete(cwd);
      }
      throw err;
    }
    return {
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
    this.stopKeepalive();
    try {
      this.wire.close();
    } catch {
      // already closed
    }
  }

  // ─── Liveness probe ─────────────────────────────────────────────

  private startKeepalive(): void {
    this.pingIntervalId = setInterval(() => {
      // Previous ping still unanswered when the next tick arrives —
      // the pong deadline below will close first, so just skip.
      if (this.pongTimeoutId !== null) return;
      try {
        this.wire.send({ type: "ping", t: Date.now() });
      } catch {
        // Wire refused the write — it's dead; force the close path.
        this.probeFailed("ping send failed");
        return;
      }
      this.pongTimeoutId = setTimeout(
        () => this.probeFailed("pong timeout"),
        PONG_TIMEOUT_MS,
      );
    }, PING_INTERVAL_MS);
  }

  private stopKeepalive(): void {
    if (this.pingIntervalId !== null) {
      clearInterval(this.pingIntervalId);
      this.pingIntervalId = null;
    }
    if (this.pongTimeoutId !== null) {
      clearTimeout(this.pongTimeoutId);
      this.pongTimeoutId = null;
    }
  }

  /** Probe verdict: peer is silently dead. Close the wire — its close
   *  listener runs `onTransportClosed`, which fires onUnexpectedClose
   *  (intentionallyClosed is false) and the provider reconnects. */
  private probeFailed(reason: string): void {
    console.log(`[transport] liveness probe failed (${reason})`);
    this.stopKeepalive();
    try {
      this.wire.close();
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
        // Serialization/framing/chunking is the wire's business. A
        // refused write fails THIS request, not the transport.
        this.wire.send(frame);
      } catch (err) {
        this.pending.delete(frame.requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Install the runtime frame router + close handler on the wire.
   *  Called by `connect` exactly once, right after the hello handshake
   *  settles (which cleared its own one-shot listeners). Frames arrive
   *  already decoded, reassembled and parsed — transport quirks like
   *  chunk envelopes or half-dead-PC detection live in the wire
   *  implementations. */
  private installMessageHandlers(): void {
    this.wire.setOnClose(() => this.onTransportClosed());
    this.startKeepalive();
    this.wire.setOnFrame((parsed) => {
      const frame = parsed as {
        type?: string;
        requestId?: string;
        message?: string;
        cwd?: string;
        status?: GitStatus;
      };
      // Liveness probe answer — clears the pong deadline armed by the
      // matching ping. Any pong counts; we don't correlate echoT.
      if (frame.type === "pong") {
        if (this.pongTimeoutId !== null) {
          clearTimeout(this.pongTimeoutId);
          this.pongTimeoutId = null;
        }
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
  }

  private onTransportClosed(): void {
    this.stopKeepalive();
    const err = new Error("daemon connection closed");
    for (const [, slot] of this.pending) slot.reject(err);
    this.pending.clear();
    this.gitStatusCallbacks.clear();
    if (!this.intentionallyClosed) {
      const cb = this.onUnexpectedClose;
      this.onUnexpectedClose = null;
      cb?.();
    }
  }
}

// ─── DaemonClient facade ────────────────────────────────────────────────

/**
 * Stable, long-lived public client. The Provider instantiates ONE per
 * app lifetime and consumers bind to it; the underlying `Transport`
 * comes and goes on transport reconnects without changing this object's
 * identity.
 *
 * Why this layer exists:
 *   - Removes the `client: DaemonClient | null` flicker every consumer
 *     used to gate on (the brief null between `_detachTransport` and
 *     the next `_attachTransport`). Consumers see a steady reference;
 *     RPCs await `readyPromise` internally.
 *
 * RPCs (`getFilesystemRoots`, `listDirectory`, etc.) are thin
 * pass-throughs that `await this.readyPromise` then dispatch to the
 * current transport. If a transport drops while a pass-through is
 * in-flight, the request rejects with "daemon connection closed" —
 * caller handles via react-query's retry or visible error state, same
 * as today.
 *
 * Consumers holding subscriptions (`subscribeGitStatus` — git status is
 * per-cwd and cheap to re-fetch, so there is no auto-resume) read
 * `connectionStatus`
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

  constructor() {
    this.readyPromise = new Promise((r) => {
      this.resolveReady = r;
    });
  }

  /** Live diagnostics of the current transport, or null while offline.
   *  Poll from the Settings host panel — iroh samples rtt/paths fresh
   *  on every call. */
  transportDiagnostics(): TransportDiagnostics | null {
    return this.transport?.transportDiagnostics() ?? null;
  }

  /** Provider hook. Called after each successful Transport handshake;
   *  re-resolves the readyPromise. */
  _attachTransport(t: Transport): void {
    this.transport = t;
    this.resolveReady(t);
  }

  /** Provider hook. Called BEFORE the transport is closed, so the
   *  pending readyPromise gets re-armed before any RPC tries to resolve
   *  against a dead handle. */
  _detachTransport(): void {
    this.transport = null;
    // Re-arm readyPromise so any in-flight `await` blocks until the
    // next _attachTransport.
    this.readyPromise = new Promise((r) => {
      this.resolveReady = r;
    });
  }

  // ─── Pass-through RPCs (await readyPromise → dispatch) ────────────

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

  async getWorkingTreeDiff(cwd: string): Promise<{
    isRepo: boolean;
    diff: string;
    fileCount: number;
    truncated: boolean;
  }> {
    const t = await this.readyPromise;
    return t.getWorkingTreeDiff(cwd);
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

  /** One-shot git status snapshot for `cwd` (react-query queryFn). */
  async getGitStatus(cwd: string): Promise<GitStatus> {
    const t = await this.readyPromise;
    return t.getGitStatus(cwd);
  }

  /** Every port the Mac's running servers listen on (one-shot). */
  async getForwardPorts(): Promise<ForwardPort[]> {
    const t = await this.readyPromise;
    return t.getForwardPorts();
  }

  /**
   * Per-cwd git status subscribe — a pure change stream (initial snapshot
   * comes from `getGitStatus`). Pass-through to the current transport —
   * NO facade-managed registry (git status is cheap to re-fetch and per-cwd
   * subscriptions don't have the same continuity requirements as
   * transcript). Consumers re-subscribe on transport swap by including
   * `daemonClient.connectionEpoch` in their useEffect deps.
   */
  async subscribeGitStatus(
    cwd: string,
    onUpdate: (status: GitStatus) => void,
  ): Promise<{ unsubscribe: () => Promise<void> }> {
    const t = await this.readyPromise;
    return t.subscribeGitStatus(cwd, onUpdate);
  }
}

// Shared-connection orchestration lives in `daemon-client-context.tsx` —
// this module exports primitives (Transport class + DaemonClient facade
// + pair / reconnect / store helpers); the Context
// owns the connection lifecycle + status machine and drives the singleton
// below (attach / detach Transport).

/**
 * The app's one DaemonClient, as a module-level singleton.
 *
 * The facade is framework-agnostic (no React, no hooks; its constructor
 * just arms a readyPromise), and there is only ever one connection per
 * app process — so it lives at module scope, mirroring the TanStack Query
 * `queryClient`, and non-React code can reference it directly.
 *
 * React consumers still go through `useDaemonClient()` — the Provider
 * owns the connection lifecycle (connect / reconnect / pair / unpair) and
 * the status machine that drives UI, and merely attaches/detaches the
 * Transport on this singleton. Safe at module scope because RN is a
 * single-process, single-user runtime — the SSR "shared cache leaks
 * across requests" hazard that makes TanStack Query avoid module-global
 * clients on the server doesn't exist here.
 */
export const daemonClient = new DaemonClient();
