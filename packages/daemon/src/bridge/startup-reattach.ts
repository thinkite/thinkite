/**
 * M3.4 startup re-attach + M3.6 SCOPE.
 *
 * On daemon boot, scan sidecode session metadata for any session whose
 * `bridge` field is populated (= it was bridged at last shutdown) and revive
 * the BridgeTransport so the cse_ keeps mirroring outbound + claude.ai
 * inbound prompts can drive the local query loop again.
 *
 * SCOPE (M3.6): every session with `bridge !== undefined`. Explicitly
 * INCLUDES archived sessions (`isArchived: true`) — claude.ai supports
 * unarchive and the bridge must survive that cycle so when the user
 * unarchives mid-conversation the resume is seamless. Excludes only sessions
 * that were explicitly unbridged (`detach` cleared the field) or were never
 * bridged in the first place.
 *
 * 4-way classifier (mirrors M3.5 reactive reconnect — same source-of-truth
 * pattern: let `fetchRemoteCredentials` decide):
 *   - probe returns null → session truly gone server-side (user deleted on
 *     claude.ai while daemon was off); clear worker state + skip.
 *   - probe returns CredentialsFailure → terminal (untrusted_device /
 *     session_stale_relogin); clear worker state + skip.
 *   - probe returns RemoteCredentials → live; `runtimeManager.getOrCreate`
 *     materializes a runtime shell + `bridgeService.attach(..., existing)`
 *     re-attaches via the M3.4.1 existingCseSessionId path (no
 *     createCodeSession, no overwrite of disk worker state).
 *   - attach throws → transient; leave worker state intact. Caller doesn't
 *     retry here — M3.5's per-session backoff doesn't apply pre-attach
 *     (there's no AttachedSession entry to schedule against), so this falls
 *     through to the next daemon boot. Acceptable: startup is once-per-boot,
 *     and a daemon restart is the user's natural retry knob.
 *
 * Sequential V0: at single-digit bridged sessions per user, a serial
 * ~1-2s probe per session is fine and avoids hammering /bridge with
 * concurrent epoch bumps (each fetchRemoteCredentials increments the
 * server-side epoch — see M3.5.7 race-cascade notes). If V0.5+ hits 20+
 * bridges, switch to `p-limit`-style fan-out with concurrency cap.
 *
 * Fire-and-forget at call site (index.ts): daemon shouldn't block iOS
 * accept on re-attach. iOS subscribes don't depend on bridge state — the
 * bridge is purely for claude.ai cross-client sync; a not-yet-re-attached
 * session is functionally equivalent to a never-bridged session until the
 * orchestrator catches up.
 */

import {
  clearBridgeWorkerState as defaultClearBridgeWorkerState,
  listSidecodeSessions as defaultListSidecodeSessions,
} from "../sidecode-sessions.js";
import type {
  BridgeAttachableRuntime,
  BridgeService,
} from "./bridge-service.js";
import type { TokenSource } from "./bridge-transport.js";
import {
  fetchRemoteCredentials as defaultFetchRemoteCredentials,
  isCredentialsFailure,
} from "./sdk-adapter.js";

/** Outcome counts from one re-attach pass. `total` is the number of
 *  bridged sessions found on disk; the three outcome counters partition
 *  it (attached + cleared + failed === total). */
export interface ReattachSummary {
  total: number;
  attached: number;
  cleared: number;
  failed: number;
}

/** Minimal runtime-manager surface the orchestrator needs. SessionRuntimeManager
 *  satisfies this structurally — kept narrow so tests can inject a fake
 *  without spinning up SessionRuntime. */
export interface ReattachableRuntimeManager {
  getOrCreate(sessionId: string): BridgeAttachableRuntime;
}

export interface ReattachOptions {
  home: string;
  runtimeManager: ReattachableRuntimeManager;
  bridgeService: BridgeService;
  /** Token source for the creds probe — production = the daemon's
   *  OAuthRefreshManager (same instance the BridgeService uses). */
  oauth: TokenSource;
  log: (msg: string) => void;
  /** Override the /bridge baseUrl (staging / local). When set, both the
   *  creds probe AND the eventual attachBridgeSession use it — they must
   *  agree or the worker_jwt won't validate. */
  baseUrl?: string;
  /** Test seams. */
  listSidecodeSessions?: typeof defaultListSidecodeSessions;
  clearBridgeWorkerState?: typeof defaultClearBridgeWorkerState;
  fetchRemoteCredentials?: typeof defaultFetchRemoteCredentials;
}

export async function reattachBridgedSessions(
  opts: ReattachOptions,
): Promise<ReattachSummary> {
  const list = opts.listSidecodeSessions ?? defaultListSidecodeSessions;
  const clearBridge =
    opts.clearBridgeWorkerState ?? defaultClearBridgeWorkerState;
  const probe = opts.fetchRemoteCredentials ?? defaultFetchRemoteCredentials;

  const allSessions = list(opts.home);
  // M3.6 SCOPE: bridged-or-not is the only filter. Archived sessions go
  // through the re-attach path too (see file docstring).
  const bridged = allSessions.filter((m) => m.bridge !== undefined);

  let attached = 0;
  let cleared = 0;
  let failed = 0;

  for (const meta of bridged) {
    const cseId = meta.bridge?.cseSessionId;
    const lastSeq = meta.bridge?.lastSSESequenceNum ?? 0;
    if (cseId === undefined) {
      // Type-guard impossible state — filter above already proved
      // bridge !== undefined. Defensive only.
      continue;
    }

    // OAuth refresh. A failure here is account-level (keychain missing,
    // refresh-token expired) — affects EVERY session this pass, not just
    // one. We still try each session: the failure may be transient (DNS
    // blip) and a 2nd attempt could succeed. Conservative: count as failed,
    // don't clear (user might just need to /login and reboot).
    let accessToken: string;
    try {
      accessToken = await opts.oauth.ensureFresh();
    } catch (err) {
      opts.log(
        `[bridge] reattach ${meta.cliSessionId}: OAuth refresh failed — ${errMsg(err)}`,
      );
      failed++;
      continue;
    }

    // Probe + new creds in one server round-trip. Same discriminator the
    // M3.5 reactive reconnect uses — keeps the source of truth consistent
    // across recovery paths.
    let creds: Awaited<ReturnType<typeof probe>>;
    try {
      creds = await probe({
        sessionId: cseId,
        accessToken,
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
      });
    } catch (err) {
      opts.log(
        `[bridge] reattach ${meta.cliSessionId}: creds probe threw — ${errMsg(err)} (worker state preserved, will retry on next daemon boot)`,
      );
      failed++;
      continue;
    }

    if (creds === null) {
      opts.log(
        `[bridge] reattach ${meta.cliSessionId}: creds null (cse_ ${cseId} deleted server-side or persistent network failure) — clearing worker state`,
      );
      clearBridge(opts.home, meta.cliSessionId);
      cleared++;
      continue;
    }

    if (isCredentialsFailure(creds)) {
      opts.log(
        `[bridge] reattach ${meta.cliSessionId}: creds failure ${creds.reason} — clearing worker state, user needs claude /login`,
      );
      clearBridge(opts.home, meta.cliSessionId);
      cleared++;
      continue;
    }

    // Live cse_. Materialize a runtime shell (lazy — the query loop
    // doesn't spawn until the first inbound prompt or iOS sendPrompt),
    // then attach via the M3.4.1 existing path.
    const runtime = opts.runtimeManager.getOrCreate(meta.cliSessionId);
    try {
      await opts.bridgeService.attach(
        meta.cliSessionId,
        runtime,
        {
          // Title is server-already-set on the existing cse_; the
          // attachBridgeSession path skips createCodeSession and the field
          // is ignored. Pass meta.title for the type and for log/debug.
          title: meta.title,
          cwd: meta.cwd,
          ...(meta.model !== undefined ? { model: meta.model } : {}),
          ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        },
        {
          cseSessionId: cseId,
          lastSSESequenceNum: lastSeq,
        },
      );
      attached++;
    } catch (err) {
      opts.log(
        `[bridge] reattach ${meta.cliSessionId}: bridgeService.attach threw — ${errMsg(err)} (worker state preserved, will retry on next daemon boot)`,
      );
      failed++;
    }
  }

  return {
    total: bridged.length,
    attached,
    cleared,
    failed,
  };
}

/**
 * Convenience: format a `ReattachSummary` as a single-line log message.
 * Used by daemon startup to surface the outcome in one line.
 */
export function summarizeReattach(s: ReattachSummary): string {
  return `[bridge] startup re-attach: ${s.attached}/${s.total} attached, ${s.cleared} cleared, ${s.failed} failed`;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
