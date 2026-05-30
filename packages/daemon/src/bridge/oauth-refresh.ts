/**
 * OAuthRefreshManager — the daemon's single OAuth-token keeper.
 *
 * The keychain `Claude Code-credentials` access token expires ~daily and is
 * SHARED across CLI / Desktop / sidecode. The `claude` binary refreshes it
 * on use, so an ACTIVE session stays fresh for free. But sidecode's lazy
 * query means a re-attached/idle bridge has NO binary running — nothing
 * refreshes the token, yet the 4h worker-jwt refresh (`fetchRemoteCredentials`)
 * needs a valid OAuth token. So to keep idle CCR sessions connectable,
 * sidecode must refresh the OAuth token itself.
 *
 * The token is keychain-GLOBAL → ONE manager serves ALL sessions (not
 * per-session). Two jobs:
 *   1. `ensureFresh()` — reactive backstop. Before a control-plane call
 *      (createCodeSession / fetchRemoteCredentials), get a token that's
 *      valid long enough to complete it. Concurrent callers share one
 *      in-flight refresh.
 *   2. proactive timer — while `start()`ed (i.e. ≥1 bridge attached),
 *      refresh ~30min before expiry so the token never lapses under an idle
 *      bridge. `stop()` when no bridges remain.
 *
 * Refresh recipe (source: claude-code-source services/oauth/client.ts
 * `refreshOAuthToken` + constants/oauth.ts): POST platform.claude.com/v1/oauth/token
 * with the Claude Code public PKCE client_id (no secret) and the
 * space-joined scopes. The refresh token ROTATES — we persist the new one;
 * the old invalidates. On `invalid_grant` (another client rotated first) we
 * re-read the store before giving up. Terminal failure → re-login required.
 *
 * This manager is built in M0 but its start/stop is wired to bridge-attach
 * count in M3. M0 just needs it constructible + unit-tested via seams.
 */

import {
  defaultSecureStore,
  type OAuthCredentials,
  readCredentials,
  type SecureStore,
  writeCredentials,
} from "./credentials.js";

/** Claude Code's public PKCE client (no secret). Hard-coded in the binary
 *  + dozens of OSS tools — community-standard for subscription-OAuth refresh. */
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/** Token endpoint — platform.claude.com, NOT api.anthropic.com. */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
/** Default scopes when the stored creds carry none (CLAUDE_AI_OAUTH_SCOPES). */
const DEFAULT_SCOPES = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
];

/** Proactive timer fires this long BEFORE expiry. */
const PROACTIVE_LEAD_MS = 30 * 60_000;
/** ensureFresh refreshes when the token expires within this window. */
const FRESH_BUFFER_MS = 5 * 60_000;
/** Floor on the proactive delay (avoid a hot refresh loop on a near-expired
 *  token — after one refresh it'll get a fresh long token and reschedule). */
const MIN_TIMER_MS = 60_000;
/** Cap on the proactive delay — wake, re-read, reschedule. Bounds setTimeout
 *  drift on very long-lived tokens and lets us re-check periodically. */
const MAX_TIMER_MS = 6 * 60 * 60_000;

export type OAuthRefreshErrorKind =
  /** No credentials in the store (never logged in, or wiped). */
  | "no_credentials"
  /** Refresh token rejected and no fresher one appeared — user must re-login. */
  | "needs_relogin"
  /** Transient transport/server error — safe to retry later. */
  | "network";

export class OAuthRefreshError extends Error {
  readonly kind: OAuthRefreshErrorKind;
  constructor(kind: OAuthRefreshErrorKind, message: string) {
    super(message);
    this.name = "OAuthRefreshError";
    this.kind = kind;
  }
}

export interface OAuthRefreshManagerOptions {
  /** Credentials store. Default = platform default (keychain/plaintext). */
  store?: SecureStore;
  /** `fetch` impl (test seam). Default = global fetch. */
  fetchImpl?: typeof fetch;
  /** Clock (test seam). Default = Date.now. */
  now?: () => number;
  /** Timer seam (test). Default = setTimeout. Return value is opaque. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  /** Timer-clear seam (test). Default = clearTimeout. */
  clearTimer?: (handle: unknown) => void;
  /** Optional logger for background (proactive-timer) failures. */
  log?: (message: string) => void;
}

function parseScopes(scope: unknown): string[] | null {
  if (typeof scope !== "string") return null;
  const parsed = scope.split(" ").filter(Boolean);
  return parsed.length > 0 ? parsed : null;
}

/** Sentinel for a 400 invalid_grant (terminal-unless-another-client-rotated). */
class InvalidGrantError extends Error {
  constructor() {
    super("invalid_grant");
    this.name = "InvalidGrantError";
  }
}

/** Don't let the refresh timer keep the event loop alive. */
function maybeUnref(handle: unknown): void {
  const h = handle as { unref?: () => void };
  if (typeof h?.unref === "function") h.unref();
}

export class OAuthRefreshManager {
  private readonly store: SecureStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly log: (message: string) => void;

  /** True between start() and stop(); gates proactive scheduling. */
  private running = false;
  /** Active proactive-timer handle, or null. */
  private timer: unknown = null;
  /** In-flight refresh, shared by concurrent ensureFresh/timer callers. */
  private refreshing: Promise<OAuthCredentials> | null = null;

  constructor(options: OAuthRefreshManagerOptions = {}) {
    this.store = options.store ?? defaultSecureStore();
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer =
      options.clearTimer ??
      ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.log = options.log ?? (() => {});
  }

  /**
   * Begin proactive refreshing. Idempotent. Call when the first bridge
   * attaches. Reads the current token and schedules a refresh ahead of its
   * expiry; if there are no creds yet it simply stays armed (the next
   * ensureFresh, after login, will reschedule).
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    const current = readCredentials(this.store);
    if (current) this.scheduleProactive(current.expiresAt);
  }

  /** Stop proactive refreshing and cancel any pending timer. Call when the
   *  last bridge detaches. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }

  /**
   * Return a valid access token, refreshing first if it's within the expiry
   * buffer (or already expired). Throws OAuthRefreshError on no-credentials
   * / needs-relogin / network. Concurrent calls share one refresh.
   *
   * This is the cold-start backstop the create path uses so a `null` from
   * createCodeSession is known to be non-token.
   */
  async ensureFresh(): Promise<string> {
    const current = readCredentials(this.store);
    if (!current) {
      throw new OAuthRefreshError(
        "no_credentials",
        "no Claude Code OAuth credentials found — run `claude /login`",
      );
    }
    if (current.expiresAt - this.now() > FRESH_BUFFER_MS) {
      return current.accessToken;
    }
    const refreshed = await this.refresh();
    return refreshed.accessToken;
  }

  /** Coalesced refresh — one in-flight at a time. */
  private refresh(): Promise<OAuthCredentials> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async doRefresh(): Promise<OAuthCredentials> {
    const current = readCredentials(this.store);
    if (!current) {
      throw new OAuthRefreshError(
        "no_credentials",
        "no Claude Code OAuth credentials found — run `claude /login`",
      );
    }
    let refreshed: OAuthCredentials;
    try {
      refreshed = await this.postRefresh(current);
    } catch (err) {
      if (err instanceof InvalidGrantError) {
        // The refresh token was rejected — most often because CLI/Desktop
        // rotated it first (shared keychain). Re-read: another client may
        // have just written a fresh token we can use as-is.
        const reread = readCredentials(this.store);
        if (
          reread &&
          reread.refreshToken !== current.refreshToken &&
          reread.expiresAt - this.now() > FRESH_BUFFER_MS
        ) {
          this.scheduleProactive(reread.expiresAt);
          return reread;
        }
        throw new OAuthRefreshError(
          "needs_relogin",
          "OAuth refresh token rejected (invalid_grant) — run `claude /login`",
        );
      }
      throw new OAuthRefreshError(
        "network",
        `OAuth token refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    writeCredentials(refreshed, this.store);
    this.scheduleProactive(refreshed.expiresAt);
    return refreshed;
  }

  /** The raw refresh-grant HTTP call. Throws InvalidGrantError on a 400
   *  invalid_grant, a generic Error on any other non-2xx / transport fault. */
  private async postRefresh(
    current: OAuthCredentials,
  ): Promise<OAuthCredentials> {
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: CLIENT_ID,
        scope: (current.scopes.length > 0
          ? current.scopes
          : DEFAULT_SCOPES
        ).join(" "),
      }),
    });
    if (!res.ok) {
      let body = "";
      try {
        body = await res.text();
      } catch {
        // ignore — body is best-effort for diagnostics
      }
      if (res.status === 400 && body.includes("invalid_grant")) {
        throw new InvalidGrantError();
      }
      throw new Error(`HTTP ${res.status}${body ? `: ${body}` : ""}`);
    }
    const data = (await res.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
      scope?: unknown;
    };
    if (typeof data.access_token !== "string") {
      throw new Error("refresh response missing access_token");
    }
    // Default to 1h (NOT 0) when the server omits/zeroes expires_in: a 0
    // would mark the new token instantly-expired and trigger a refresh storm
    // on the next ensureFresh. The server always sends it; this is purely
    // defensive (matches cc-gateway's `data.expires_in || 3600`).
    const expiresIn =
      typeof data.expires_in === "number" && data.expires_in > 0
        ? data.expires_in
        : 3600;
    return {
      accessToken: data.access_token,
      // Rotation: persist the new refresh token; fall back to the old one if
      // the server didn't rotate (some grants don't).
      refreshToken:
        typeof data.refresh_token === "string"
          ? data.refresh_token
          : current.refreshToken,
      expiresAt: this.now() + expiresIn * 1000,
      scopes: parseScopes(data.scope) ?? current.scopes,
      // We deliberately DON'T re-fetch the profile (subscriptionType /
      // rateLimitTier) — preserve whatever was stored so writeCredentials
      // keeps the keychain entry complete for the binary/Desktop.
      subscriptionType: current.subscriptionType,
      rateLimitTier: current.rateLimitTier,
    };
  }

  /** (Re)arm the proactive timer for a token expiring at `expiresAt`. No-op
   *  when not running (start() gates it). */
  private scheduleProactive(expiresAt: number): void {
    if (!this.running) return;
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    const lead = expiresAt - this.now() - PROACTIVE_LEAD_MS;
    const delay = Math.min(MAX_TIMER_MS, Math.max(MIN_TIMER_MS, lead));
    const handle = this.setTimer(() => {
      this.timer = null;
      void this.refresh().catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.log(`proactive OAuth refresh failed: ${msg}`);
        // On a recoverable (network) failure, retry on the floor delay so an
        // idle bridge eventually recovers without a binary running. Terminal
        // (needs_relogin/no_credentials) failures stop rescheduling — the
        // session surfaces the error on its next ensureFresh.
        if (
          this.running &&
          (!(err instanceof OAuthRefreshError) || err.kind === "network")
        ) {
          this.armRetry();
        }
      });
    }, delay);
    this.timer = handle;
    maybeUnref(handle);
  }

  /** Schedule a floor-delay retry after a recoverable proactive failure. */
  private armRetry(): void {
    if (!this.running) return;
    const handle = this.setTimer(() => {
      this.timer = null;
      const current = readCredentials(this.store);
      if (current) this.scheduleProactive(current.expiresAt);
    }, MIN_TIMER_MS);
    this.timer = handle;
    maybeUnref(handle);
  }
}
