/**
 * BridgeTransport — wraps one `attachBridgeSession` handle as a
 * `RuntimeBridge`, the CCR mirror member of a session's multiplex mesh.
 *
 * Slice M1 = WRITE-OUT (mirror to claude.ai, read-only): opened
 * `outboundOnly: true`, the SSE read stream is NOT opened and inbound
 * prompts never fire — only write / sendResult / reportState / close.
 *
 * Slice M2 = READ-IN (bidirectional): the caller passes an `inbound` bag of
 * handlers (onInboundMessage / onInterrupt / onSetModel) and the transport
 * flips `outboundOnly: false` so the SSE read stream opens. `outboundOnly`
 * is DERIVED from inbound presence (no handlers → mirror; handlers →
 * bidirectional), overridable via the explicit `outboundOnly` param. The
 * SDK already filters echoes of our own outbound writes + re-deliveries
 * before onInboundMessage fires, so it only sees genuinely-new claude.ai
 * prompts. Each inbound handler is wrapped so a fault in OUR code can't
 * propagate into the SDK's SSE read loop (same isolation as the outbound
 * forwardToBridge try/catch).
 *
 * Lifecycle (the fixed `/bridge` trio + a token preflight — see
 * project_sidecode_ccr_architecture "Call order"):
 *   ① ensureFresh()                   — OAuth token valid before create
 *   ② createCodeSession(tags,cwd,model) → cse_* id
 *   ③ fetchRemoteCredentials(cse_)    → worker_jwt + epoch (the call IS the
 *                                       worker register; bumps epoch)
 *   ④ attachBridgeSession(outboundOnly) → handle, then await isConnected()
 *
 * Ownership: BridgeTransport owns the handle's lifetime, NOT the query loop.
 * `runtime.bridge` is set to this transport by the attach wiring and cleared
 * by `close()` — the run-query finally deliberately leaves `bridge` intact
 * so a bridge outlives an idle (lazy) query (the multiplex invariant).
 *
 * Errors here NEVER propagate into the query loop: the loop's forwardToBridge
 * already try/catches every write. attach() itself can fail (returns a
 * typed error) — that's the caller's concern, not the pillar path's.
 */

import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

import type { RuntimeBridge } from "../runtime/session-runtime.js";
import {
  type AttachBridgeSessionOptions,
  attachBridgeSession,
  type BridgeSessionHandle,
  type CreateCodeSessionParams,
  createCodeSession,
  fetchRemoteCredentials,
  isCredentialsFailure,
} from "./sdk-adapter.js";

/** Verdict returned to claude.ai for a set_permission_mode control_request.
 *  Mirrors the SDK's `onSetPermissionMode` return type. */
export type PermissionModeVerdict = { ok: true } | { ok: false; error: string };

/**
 * Inbound (read-in) handlers — the M2 bidirectional surface. Supplied by the
 * caller (BridgeService in 2.2+; a spike in 2.1) and forwarded to the SDK's
 * attachBridgeSession. Passing this bag flips the transport to bidirectional
 * (outboundOnly: false) unless `outboundOnly` is set explicitly. Every
 * handler is invoked from the SDK's SSE read loop, so the transport wraps
 * each in a try/catch — a fault in OUR handler must not tear down the stream.
 */
export interface BridgeInboundHandlers {
  /**
   * A genuinely-new user prompt typed on claude.ai. The SDK has already
   * filtered echoes of our outbound writes AND re-deliveries of prompts we
   * already forwarded, so this fires only for real remote prompts. M2.2
   * routes it into the session's pushPrompt path; 2.1 logs only. May be
   * async (SDK awaits attachment resolution).
   */
  onInboundMessage?: (msg: unknown) => void | Promise<void>;
  /**
   * claude.ai pressed stop. The SDK has ALREADY auto-replied to the
   * `interrupt` control_request — this is a pure notification, so the
   * handler just acts (M2.4 → query.interrupt()). No control_response owed.
   */
  onInterrupt?: () => void;
  /**
   * claude.ai changed the model selector. M2.4 → applyFlagSettings({model}).
   * `undefined` = reset to default.
   */
  onSetModel?: (model: string | undefined) => void;
  /**
   * claude.ai changed the permission-mode selector. Return a verdict so the
   * SDK can send an accurate control_response (success vs error). Omitting
   * this handler is NOT silent: the SDK's bridgeMessaging.handleServerControlRequest
   * (see claude-code-source) returns a generic `"set_permission_mode is not
   * supported in this context (onSetPermissionMode callback not registered)"`
   * error instead of false-success — fine semantically but unhelpful to the
   * user on claude.ai. V0 wires a stub that returns a sidecode-specific
   * reason ("bypassPermissions is fixed for V0"), and the SDK forwards it.
   *
   * Synchronous to match the SDK signature exactly. A throw here is wrapped
   * by the transport into `{ok:false, error}` so the SDK never sees an
   * exception — same isolation as the other inbound handlers.
   */
  onSetPermissionMode?: (mode: PermissionMode) => PermissionModeVerdict;
}

/** Minimal token source — the OAuthRefreshManager satisfies this. Injected
 *  so tests don't touch the real keychain. */
export interface TokenSource {
  /** Returns a valid OAuth access token, refreshing if near expiry. Throws
   *  on no-credentials / needs-relogin / network (OAuthRefreshError). */
  ensureFresh(): Promise<string>;
}

export type BridgeAttachErrorKind =
  /** OAuth preflight failed (no creds / relogin / network) — see `.cause`. */
  | "auth"
  /** `createCodeSession` returned null after a fresh token → network/gate
   *  (the gate = no `tengu_ccr_bridge`; token already ruled out by preflight). */
  | "create_failed"
  /** `fetchRemoteCredentials` returned a terminal CredentialsFailure
   *  (untrusted_device / session_stale_relogin) or null (transport). */
  | "credentials_failed"
  /** attach opened but never reached isConnected() within the timeout. */
  | "connect_timeout";

export class BridgeAttachError extends Error {
  readonly kind: BridgeAttachErrorKind;
  readonly cause?: unknown;
  constructor(kind: BridgeAttachErrorKind, message: string, cause?: unknown) {
    super(message);
    this.name = "BridgeAttachError";
    this.kind = kind;
    this.cause = cause;
  }
}

export interface BridgeAttachParams {
  /** Token source (OAuthRefreshManager in production). */
  tokens: TokenSource;
  /** cloud session title (shown on claude.ai). */
  title: string;
  /** Local working directory — carried into the code-session config. */
  cwd: string;
  /** Raw SDK model key (e.g. `claude-sonnet-4-6`). Optional. */
  model?: string;
  /** Own-tag for `GET /v1/code/sessions` filtering. Default `["sidecode"]`. */
  tags?: string[];
  /** Inbound (read-in) handlers — M2 bidirectional. Omit → pure mirror (M1).
   *  Passing this opens the SSE read stream (see `outboundOnly`). */
  inbound?: BridgeInboundHandlers;
  /** Open outbound-only (mirror: no SSE read stream, inbound never fires).
   *  Default is DERIVED — `inbound === undefined` (mirror when no inbound
   *  handlers, bidirectional when present). Set explicitly to force a mode
   *  (e.g. a future privacy "view-only" bridge that still wants no inbound). */
  outboundOnly?: boolean;
  /** Fired when the transport dies permanently (401 jwt expired / 4090 epoch
   *  superseded / 4091 init fail / 403·404 perma). M3 wires reconnect here. */
  onClose?: (code: number | undefined) => void;
  /** Override host (staging/local). Default = adapter's ANTHROPIC_API_BASE. */
  baseUrl?: string;
  /** Max ms to wait for isConnected() after attach. Default 10s. */
  connectTimeoutMs?: number;
  /** Test seam: poll interval while waiting for connect. Default 250ms. */
  connectPollMs?: number;
  /** Test seams — override the SDK calls (default = sdk-adapter). */
  deps?: {
    createCodeSession?: typeof createCodeSession;
    fetchRemoteCredentials?: typeof fetchRemoteCredentials;
    attachBridgeSession?: typeof attachBridgeSession;
  };
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_POLL_MS = 250;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * The CCR mirror transport. Construct via `BridgeTransport.attach(...)` —
 * the constructor is private so an instance always wraps a connected handle.
 */
export class BridgeTransport implements RuntimeBridge {
  /** The cse_* cloud session id (claude.ai/code/<cseSessionId>). */
  readonly cseSessionId: string;
  private readonly handle: BridgeSessionHandle;
  private closed = false;
  /** Last state forwarded to the worker — for local dedup so repeated
   *  running/idle reports collapse (Claude Code reports running at BOTH
   *  prompt-submit and first model frame; its CCRClient dedupes, but we
   *  dedupe locally too so we don't rely on the /bridge path doing it). */
  private lastReportedState: "idle" | "running" | "requires_action" | null =
    null;

  private constructor(cseSessionId: string, handle: BridgeSessionHandle) {
    this.cseSessionId = cseSessionId;
    this.handle = handle;
  }

  /**
   * Run the full attach sequence and return a connected transport, or throw
   * a typed BridgeAttachError. Never partially-leaks: on any failure after
   * the handle opened, the handle is closed before throwing.
   */
  static async attach(params: BridgeAttachParams): Promise<BridgeTransport> {
    const create = params.deps?.createCodeSession ?? createCodeSession;
    const fetchCreds =
      params.deps?.fetchRemoteCredentials ?? fetchRemoteCredentials;
    const attach = params.deps?.attachBridgeSession ?? attachBridgeSession;

    // ① OAuth preflight — a fresh token before the (status-swallowing) create.
    let accessToken: string;
    try {
      accessToken = await params.tokens.ensureFresh();
    } catch (err) {
      throw new BridgeAttachError(
        "auth",
        `OAuth preflight failed: ${err instanceof Error ? err.message : String(err)}`,
        err,
      );
    }

    // ② createCodeSession → cse_*  (null = network/gate, token already ruled out)
    const createParams: CreateCodeSessionParams = {
      accessToken,
      title: params.title,
      tags: params.tags ?? ["sidecode"],
      cwd: params.cwd,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.baseUrl !== undefined ? { baseUrl: params.baseUrl } : {}),
    };
    const cseSessionId = await create(createParams);
    if (cseSessionId === null) {
      throw new BridgeAttachError(
        "create_failed",
        "createCodeSession returned null (network or CCR gate — token was preflighted fresh)",
      );
    }

    // ③ fetchRemoteCredentials → worker_jwt + epoch
    const creds = await fetchCreds({
      sessionId: cseSessionId,
      accessToken,
      ...(params.baseUrl !== undefined ? { baseUrl: params.baseUrl } : {}),
    });
    if (creds === null || isCredentialsFailure(creds)) {
      const reason = creds === null ? "transport error" : creds.reason;
      throw new BridgeAttachError(
        "credentials_failed",
        `fetchRemoteCredentials failed: ${reason}`,
        creds,
      );
    }

    // ④ attachBridgeSession → handle, then await connect. `outboundOnly` is
    //    derived from inbound presence (no handlers → mirror; handlers →
    //    bidirectional), overridable via the explicit param. Each inbound
    //    handler is wrapped so a fault in OUR code can't tear down the SDK's
    //    SSE read loop (same isolation as the outbound forwardToBridge).
    const inbound = params.inbound;
    const outboundOnly = params.outboundOnly ?? inbound === undefined;
    let closeCode: number | undefined;
    const attachOpts: AttachBridgeSessionOptions = {
      sessionId: cseSessionId,
      apiBaseUrl: creds.api_base_url,
      epoch: creds.worker_epoch,
      ingressToken: creds.worker_jwt,
      outboundOnly,
      onClose: (code) => {
        closeCode = code;
        params.onClose?.(code);
      },
    };
    if (inbound?.onInboundMessage !== undefined) {
      const handler = inbound.onInboundMessage;
      attachOpts.onInboundMessage = (msg) => {
        try {
          const r = handler(msg);
          if (r instanceof Promise) r.catch(() => {});
        } catch {
          // swallow — an inbound-handler fault must not kill the read stream.
        }
      };
    }
    if (inbound?.onInterrupt !== undefined) {
      const handler = inbound.onInterrupt;
      attachOpts.onInterrupt = () => {
        try {
          handler();
        } catch {
          // swallow — see onInboundMessage.
        }
      };
    }
    if (inbound?.onSetModel !== undefined) {
      const handler = inbound.onSetModel;
      attachOpts.onSetModel = (model) => {
        try {
          handler(model);
        } catch {
          // swallow — see onInboundMessage.
        }
      };
    }
    if (inbound?.onSetPermissionMode !== undefined) {
      const handler = inbound.onSetPermissionMode;
      attachOpts.onSetPermissionMode = (mode) => {
        // Unlike the other inbound handlers, this one MUST return a verdict
        // (the SDK forwards it as the control_response). Catch a throw and
        // turn it into a generic error verdict so the SDK still gets a
        // value-shaped reply — the server otherwise hangs on the request.
        try {
          return handler(mode);
        } catch {
          return {
            ok: false,
            error: "set_permission_mode handler threw",
          };
        }
      };
    }
    const handle = await attach(attachOpts);

    const timeoutMs = params.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const pollMs = params.connectPollMs ?? DEFAULT_CONNECT_POLL_MS;
    const deadline = Date.now() + timeoutMs;
    while (!handle.isConnected() && Date.now() < deadline) {
      if (closeCode !== undefined) {
        throw new BridgeAttachError(
          "connect_timeout",
          `bridge transport closed during connect (code ${closeCode})`,
        );
      }
      await sleep(pollMs);
    }
    if (!handle.isConnected()) {
      try {
        handle.close();
      } catch {
        // best-effort cleanup
      }
      throw new BridgeAttachError(
        "connect_timeout",
        `bridge did not connect within ${timeoutMs}ms`,
      );
    }

    return new BridgeTransport(cseSessionId, handle);
  }

  // ─── RuntimeBridge ──────────────────────────────────────────────────────

  /** Forward one raw SDKMessage to the cloud mirror. No-op after close. */
  write(msg: unknown): void {
    if (this.closed) return;
    this.handle.write(msg as Parameters<BridgeSessionHandle["write"]>[0]);
  }

  /** Signal turn completion so claude.ai stops its "working" spinner. */
  sendResult(): void {
    if (this.closed) return;
    this.handle.sendResult();
  }

  /** PUT /worker state — running on turn start, idle on turn end. Required for
   *  claude.ai to show the session as running (M1.5-verified). Deduped: a
   *  repeated state is a no-op (the tap reports running at both prompt-submit
   *  and first model frame — see forwardToBridge). No-op after close.
   *  Best-effort: a reportState failure must not break the turn. */
  reportState(state: "idle" | "running" | "requires_action"): void {
    if (this.closed) return;
    if (state === this.lastReportedState) return;
    this.lastReportedState = state;
    try {
      this.handle.reportState(state);
    } catch {
      // best-effort — state reporting failure must not break the mirror.
      // Reset so a transient failure can be retried by the next report.
      this.lastReportedState = null;
    }
  }

  /** Tear down the transport. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.handle.close();
    } catch {
      // close() is best-effort — the daemon is dropping this bridge anyway.
    }
  }

  /** Current SSE high-water mark (for M3 WorkerState checkpointing). Stays 0
   *  in outbound-only mode — verify writes via events readback, not this. */
  getSequenceNum(): number {
    return this.handle.getSequenceNum();
  }

  get isConnected(): boolean {
    return !this.closed && this.handle.isConnected();
  }
}
