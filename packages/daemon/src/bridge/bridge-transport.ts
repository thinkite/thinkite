/**
 * BridgeTransport — wraps one `attachBridgeSession` handle as a
 * `RuntimeBridge`, the CCR mirror member of a session's multiplex mesh.
 *
 * Slice M1 = WRITE-OUT (mirror to claude.ai, read-only). The transport is
 * opened `outboundOnly: true`: the SSE read stream is NOT opened, inbound
 * prompts from claude.ai don't fire, and any control_request the server
 * sends gets an "outbound-only" error reply (handled inside the SDK). M2
 * flips this to bidirectional. So M1 wires ONLY write / sendResult / close.
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

import type { RuntimeBridge } from "../runtime/session-runtime.js";
import {
  type BridgeSessionHandle,
  type CreateCodeSessionParams,
  attachBridgeSession,
  createCodeSession,
  fetchRemoteCredentials,
  isCredentialsFailure,
} from "./sdk-adapter.js";

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

    // ④ attachBridgeSession(outboundOnly) → handle, then await connect.
    let closeCode: number | undefined;
    const handle = await attach({
      sessionId: cseSessionId,
      apiBaseUrl: creds.api_base_url,
      epoch: creds.worker_epoch,
      ingressToken: creds.worker_jwt,
      // M1: mirror only — no inbound stream, no control wiring. M2 flips this.
      outboundOnly: true,
      onClose: (code) => {
        closeCode = code;
        params.onClose?.(code);
      },
    });

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
