/**
 * BridgeService — daemon-level owner of all CCR bridge mirrors.
 *
 * One instance per daemon process (created in index.ts's `start`, drained in
 * `daemon.stop`). It holds:
 *   - the single OAuthRefreshManager (the keychain token is process-global →
 *     one manager serves every bridge — see project_sidecode_ccr_architecture)
 *   - a `sessionId → BridgeTransport` map of live mirrors
 *
 * Responsibilities (slice M1 = write-out only):
 *   - `attach(sessionId, runtime, params)` — open a BridgeTransport for a
 *     session, hang it on `runtime.bridge` so the query loop's forwardToBridge
 *     starts mirroring, and track it here. Starts the OAuth proactive timer
 *     on the first attach (ref-counted).
 *   - `detach(sessionId)` — close + forget one mirror. Stops the OAuth timer
 *     when the last bridge goes away.
 *   - `shutdown()` — close every mirror + stop the OAuth manager. Called from
 *     daemon.stop() AFTER runtimeManager.shutdown() (queries drained first, so
 *     no late writes race the bridge close).
 *
 * Ownership boundary: BridgeService owns the transport lifetime, NOT the query
 * loop. run-query's finally clears query/inputChannel/loopPromise but
 * deliberately leaves `runtime.bridge` intact — a bridge outlives an idle
 * (lazy) query (the multiplex invariant). So `runtime.bridge` is a mirror of
 * what this service tracks; the service is the source of truth for closing.
 *
 * M1 scope: no RPC wiring yet (that's M4's create-bridged / upgrade commands).
 * The M1.5 spike calls `attach` directly to prove end-to-end mirroring.
 */

import type { SessionRuntime } from "../runtime/session-runtime.js";
import {
  BridgeTransport,
  type TokenSource,
} from "./bridge-transport.js";

/** The subset of OAuthRefreshManager BridgeService drives. Injectable so
 *  tests pass a fake (no keychain, no timers). Production = the real manager,
 *  which also satisfies TokenSource via `ensureFresh`. */
export interface OAuthManager extends TokenSource {
  /** Begin proactive pre-expiry refreshing (idempotent). */
  start(): void;
  /** Stop proactive refreshing + cancel the pending timer. */
  stop(): void;
}

/** Params for one attach, minus the token source (the service injects its
 *  own OAuthManager) and onClose (the service wires reconnect/cleanup in M3;
 *  M1 just logs). */
export interface BridgeAttachRequest {
  /** cloud session title (shown on claude.ai). */
  title: string;
  /** local working directory — carried into the code-session config. */
  cwd: string;
  /** raw SDK model key (optional). */
  model?: string;
  /** own-tag override (default `["sidecode"]`). */
  tags?: string[];
  /** host override (staging/local). */
  baseUrl?: string;
}

/** Minimal runtime shape BridgeService needs — just the bridge slot. Keeps
 *  the service decoupled from the full SessionRuntime<EventDelta> generic so
 *  tests can pass a bare `{ bridge: null }`. */
export interface BridgeAttachableRuntime {
  bridge: SessionRuntime<unknown>["bridge"];
}

export interface BridgeServiceOptions {
  /** The daemon's OAuthRefreshManager (token source + proactive timer). */
  oauth: OAuthManager;
  /** Optional logger for attach failures / close codes. */
  log?: (message: string) => void;
  /** Test seam: override BridgeTransport.attach. */
  attachTransport?: typeof BridgeTransport.attach;
}

export class BridgeService {
  private readonly oauth: OAuthManager;
  private readonly log: (message: string) => void;
  private readonly attachTransport: typeof BridgeTransport.attach;
  /** sessionId → live mirror. The service is the source of truth for close. */
  private readonly transports = new Map<string, BridgeTransport>();
  private stopped = false;

  constructor(options: BridgeServiceOptions) {
    this.oauth = options.oauth;
    this.log = options.log ?? (() => {});
    this.attachTransport = options.attachTransport ?? BridgeTransport.attach;
  }

  /** Number of live mirrors (for tests / introspection). */
  get size(): number {
    return this.transports.size;
  }

  /** Whether a session currently has a bridge mirror. */
  has(sessionId: string): boolean {
    return this.transports.has(sessionId);
  }

  /**
   * Open a CCR mirror for `sessionId` and wire it to `runtime.bridge`.
   *
   * Idempotent-ish: if a bridge already exists for this session, the existing
   * transport is returned unchanged (a second attach is a no-op, not a
   * double-open / epoch-steal). Throws BridgeAttachError on failure — caller
   * decides how to surface it; `runtime.bridge` is left untouched on failure
   * (no half-wired mirror).
   *
   * Starts the OAuth proactive timer on the first successful attach.
   */
  async attach(
    sessionId: string,
    runtime: BridgeAttachableRuntime,
    request: BridgeAttachRequest,
  ): Promise<BridgeTransport> {
    if (this.stopped) {
      throw new Error("BridgeService is shut down");
    }
    const existing = this.transports.get(sessionId);
    if (existing !== undefined) return existing;

    // Arm the OAuth proactive timer before the first attach so ensureFresh
    // (called inside BridgeTransport.attach) benefits, and idle bridges stay
    // refreshed. start() is idempotent — safe to call on every attach.
    this.oauth.start();

    let transport: BridgeTransport;
    try {
      transport = await this.attachTransport({
        tokens: this.oauth,
        title: request.title,
        cwd: request.cwd,
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.tags !== undefined ? { tags: request.tags } : {}),
        ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
        onClose: (code) => {
          // M1: log + forget so the slot frees and a future attach can retry.
          // M3 replaces this with reconnect (re-fetchCredentials +
          // reconnectTransport) for recoverable codes.
          this.log(
            `[bridge] session ${sessionId} transport closed (code ${code ?? "?"})`,
          );
          this.forget(sessionId, runtime);
        },
      });
    } catch (err) {
      // Attach failed — if this was the only would-be bridge, stop the timer
      // we just started so an idle daemon doesn't keep a refresh loop alive
      // for zero bridges.
      if (this.transports.size === 0) this.oauth.stop();
      throw err;
    }

    this.transports.set(sessionId, transport);
    runtime.bridge = transport;
    this.log(
      `[bridge] session ${sessionId} mirroring to ${transport.cseSessionId}`,
    );
    return transport;
  }

  /**
   * Close + forget the mirror for `sessionId`. No-op if none. Clears
   * `runtime.bridge` so the query loop stops forwarding. Stops the OAuth
   * timer when the last bridge is gone.
   */
  detach(sessionId: string, runtime: BridgeAttachableRuntime): void {
    const transport = this.transports.get(sessionId);
    if (transport === undefined) return;
    try {
      transport.close();
    } catch {
      // close() is best-effort.
    }
    this.forget(sessionId, runtime);
  }

  /**
   * Remove the tracking entry + detach the runtime reference WITHOUT closing
   * (the caller already closed, or the transport closed itself via onClose).
   * Stops the OAuth timer when the map empties.
   */
  private forget(sessionId: string, runtime: BridgeAttachableRuntime): void {
    const transport = this.transports.get(sessionId);
    if (transport === undefined) return;
    this.transports.delete(sessionId);
    // Only clear the runtime's slot if it still points at THIS transport — a
    // re-attach may have already swapped in a newer one.
    if (runtime.bridge === transport) {
      runtime.bridge = null;
    }
    if (this.transports.size === 0) this.oauth.stop();
  }

  /**
   * Close every mirror + stop the OAuth manager. Idempotent. Called from
   * daemon.stop() after runtimeManager.shutdown() — queries are already
   * drained, so no forwardToBridge write can race these closes.
   *
   * Does NOT clear `runtime.bridge` slots: the runtimes are being dropped by
   * the manager's own shutdown anyway, and we don't hold runtime refs here.
   */
  shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const transport of this.transports.values()) {
      try {
        transport.close();
      } catch {
        // best-effort — process is exiting.
      }
    }
    this.transports.clear();
    this.oauth.stop();
  }
}
