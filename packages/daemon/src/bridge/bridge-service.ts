/**
 * BridgeService — daemon-level owner of all CCR bridge mirrors.
 *
 * One instance per daemon process (created in index.ts's `start`, drained in
 * `daemon.stop`). It holds:
 *   - the single OAuthRefreshManager (the keychain token is process-global →
 *     one manager serves every bridge — see project_sidecode_ccr_architecture)
 *   - a `sessionId → BridgeTransport` map of live mirrors
 *
 * Responsibilities:
 *   - `attach(sessionId, runtime, params)` — open a BridgeTransport for a
 *     session, hang it on `runtime.bridge` so the query loop's forwardToBridge
 *     starts mirroring, and (if inbound handlers were supplied to the ctor)
 *     wire the inbound bag so claude.ai-initiated prompts / interrupts /
 *     setModel route into the local session. Starts the OAuth proactive timer
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
 * Scope today (M2): the daemon constructs ONE BridgeService with the inbound
 * handlers wired (see index.ts) — bidirectional from the first attach. RPC
 * surface for creating bridged sessions / upgrading existing ones to bridged
 * (the "create-bridged" / "upgrade" iOS commands) is still M4; M1.5 + M2.5
 * spikes call `attach` directly to prove the transport works end-to-end.
 */

import type { InboundPrompt } from "../runtime/run-query.js";
import { extractInboundPrompt } from "../runtime/run-query.js";
import type { SessionRuntime } from "../runtime/session-runtime.js";
import {
  BridgeTransport,
  type PermissionModeVerdict,
  type TokenSource,
} from "./bridge-transport.js";

/** V0 verdict for any set_permission_mode control_request from claude.ai.
 *  sidecode V0 fixes `bypassPermissions` (project_no_plan_mode_v0 +
 *  feedback_no_hook_permission_interception) — no plan / acceptEdits /
 *  default mode toggle. Returning an explicit refuse beats the SDK's
 *  generic "callback not registered" fallback: the user sees WHY their
 *  mode change didn't take. Revisit when V0.5+ adds plan / approval UI. */
const V0_PERMISSION_MODE_VERDICT: PermissionModeVerdict = {
  ok: false,
  error:
    "sidecode V0 runs with bypassPermissions; remote permission-mode changes are not supported.",
};

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
  /**
   * Route an inbound (claude.ai-typed) prompt into a local turn (slice M2.2).
   * Given the session id + the extracted prompt, the impl (index.ts) looks up
   * the runtime, ensures its query loop, and pushPrompt()s — the reply then
   * streams back via M1's write-out tap. Reusing the inbound uuid makes the
   * write-back fold against claude.ai's own copy (dedup-by-uuid verified), so
   * no origin tracking is needed.
   *
   * Presence of ANY inbound handler (this, onInterrupt, or onSetModel) flips
   * every attached transport to BIDIRECTIONAL (the transport derives
   * outboundOnly:false when `inbound` is passed). Omit ALL → pure mirror (M1):
   * no inbound handlers, transports stay outboundOnly.
   */
  onInboundPrompt?: (sessionId: string, prompt: InboundPrompt) => void;
  /**
   * claude.ai pressed stop (slice M2.4). The impl (index.ts) routes this to
   * the session's `runtime.query.interrupt()`. The SDK has ALREADY auto-sent
   * the `control_response: success` (verified in claude-code-source
   * bridgeMessaging.ts `handleServerControlRequest`) — this is a pure
   * notification, we owe no response.
   */
  onInterrupt?: (sessionId: string) => void;
  /**
   * claude.ai changed the model selector (slice M2.4). The impl routes this to
   * `runtime.query.applyFlagSettings({ model })` (apply to the live query) AND
   * `updateSidecodeSessionSelection` (write metadata — the iOS chip's truth
   * source is `SessionInfo.model`, NOT the transcript, so the metadata write
   * is what makes the chip converge on next list-refresh / re-subscribe).
   * `undefined` = reset to the account default. SDK auto-sends the
   * control_response: success — we owe no response. No EventDelta is emitted
   * (claude.ai already learns the model from the `message.model` on the
   * assistant envelope we mirror; the iOS chip reads metadata, not transcript).
   */
  onSetModel?: (sessionId: string, model: string | undefined) => void;
  /** Test seam: override BridgeTransport.attach. */
  attachTransport?: typeof BridgeTransport.attach;
}

export class BridgeService {
  private readonly oauth: OAuthManager;
  private readonly log: (message: string) => void;
  private readonly attachTransport: typeof BridgeTransport.attach;
  private readonly onInboundPrompt?: (
    sessionId: string,
    prompt: InboundPrompt,
  ) => void;
  private readonly onInterrupt?: (sessionId: string) => void;
  private readonly onSetModel?: (
    sessionId: string,
    model: string | undefined,
  ) => void;
  /** sessionId → live mirror. The service is the source of truth for close. */
  private readonly transports = new Map<string, BridgeTransport>();
  private stopped = false;

  constructor(options: BridgeServiceOptions) {
    this.oauth = options.oauth;
    this.log = options.log ?? (() => {});
    this.attachTransport = options.attachTransport ?? BridgeTransport.attach;
    this.onInboundPrompt = options.onInboundPrompt;
    this.onInterrupt = options.onInterrupt;
    this.onSetModel = options.onSetModel;
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

    // When ANY caller-supplied inbound handler is wired (prompt routing M2.2,
    // interrupt M2.4, setModel M2.4), build the inbound bag so the transport
    // opens bidirectional (outboundOnly:false). Each member is included only
    // if its corresponding router was provided — partial wiring is allowed
    // (e.g. mirror + interrupt but no prompt routing, though no real config
    // does that today). Omit ALL handlers → `inbound` stays undefined → the
    // transport stays outboundOnly (M1 pure mirror).
    //
    // The transport already try/catches each handler, so a router throw can't
    // kill the SSE read loop — we still keep the handlers thin and synchronous.
    //
    // NOTE on onSetPermissionMode: this is a STATIC stub the service always
    // attaches when the transport is bidirectional. It is NOT a router the
    // caller supplies — V0 has nothing to route (bypassPermissions is fixed).
    // It does NOT participate in the `hasInbound` decision: a daemon that
    // wires zero real routers still gets a pure mirror, not a bidirectional
    // transport that only refuses permission-mode changes.
    const promptRoute = this.onInboundPrompt;
    const interruptRoute = this.onInterrupt;
    const setModelRoute = this.onSetModel;
    const hasInbound =
      promptRoute !== undefined ||
      interruptRoute !== undefined ||
      setModelRoute !== undefined;
    const inbound = hasInbound
      ? {
          ...(promptRoute !== undefined
            ? {
                onInboundMessage: (msg: unknown) => {
                  // Non-prompt inbound frames (empty / non-user) are dropped
                  // here rather than bothering the router.
                  const prompt = extractInboundPrompt(msg);
                  if (prompt !== null) promptRoute(sessionId, prompt);
                },
              }
            : {}),
          ...(interruptRoute !== undefined
            ? { onInterrupt: () => interruptRoute(sessionId) }
            : {}),
          ...(setModelRoute !== undefined
            ? {
                onSetModel: (model: string | undefined) =>
                  setModelRoute(sessionId, model),
              }
            : {}),
          // Static refuse — no router, no per-session state. Always present
          // when bidirectional so claude.ai gets a sidecode-specific error
          // instead of the SDK's generic "callback not registered" fallback.
          onSetPermissionMode: (): PermissionModeVerdict =>
            V0_PERMISSION_MODE_VERDICT,
        }
      : undefined;

    let transport: BridgeTransport;
    try {
      transport = await this.attachTransport({
        tokens: this.oauth,
        title: request.title,
        cwd: request.cwd,
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.tags !== undefined ? { tags: request.tags } : {}),
        ...(request.baseUrl !== undefined ? { baseUrl: request.baseUrl } : {}),
        ...(inbound !== undefined ? { inbound } : {}),
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
