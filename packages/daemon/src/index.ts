import { randomUUID } from "node:crypto";
import {
  getSessionInfo,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { type EventDelta, PROTOCOL_VERSION } from "@sidecodeapp/protocol";
import { BridgeService } from "./bridge/bridge-service.js";
import { OAuthRefreshManager } from "./bridge/oauth-refresh.js";
import {
  reattachBridgedSessions,
  summarizeReattach,
} from "./bridge/startup-reattach.js";
import { deleteDaemonLock, writeDaemonLock } from "./daemon-lock.js";
import { continueOnDesktop } from "./desktop/continue-on-desktop.js";
import { listDesktopSessions } from "./desktop/sessions.js";
import { GitWatcherRegistry } from "./git-watch.js";
import { resolveSidecodeHome } from "./home.js";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { foldEventDelta } from "./messages/fold.js";
import { extractLatestUsage, normalize } from "./messages/normalize.js";
import { createPairOffer } from "./pairing.js";
import { createCommandHandler } from "./router.js";
import { ensureSessionLoop, pushPrompt } from "./runtime/run-query.js";
import { SessionRuntimeManager } from "./runtime/session-runtime-manager.js";
import {
  buildNewSidecodeSession,
  listSidecodeSessions,
  updateSidecodeSessionSelection,
  writeSidecodeSession,
} from "./sidecode-sessions.js";
import { WebRTCPeerServer } from "./webrtc-peer.js";

export interface DaemonOptions {
  /** Override SIDECODE_HOME. */
  homeDir?: string;
  /** Override signaling host (for `wrangler dev`). */
  signalingHost?: string;
  signalingScheme?: "ws" | "wss";
}

export interface Daemon {
  stop(): Promise<void>;
  /** Identity fingerprint, for status / pair display. */
  readonly fingerprint: string;
  /** Number of paired clients in known_clients.json (snapshot). */
  pairedClientCount(): number;
  /** Number of currently authenticated WebRTC peers. */
  authenticatedPeerCount(): number;
  /**
   * Mint a fresh pair offer pointing at this daemon. Pure over the
   * daemon's identity + the given serviceName — no per-offer state, no
   * nonces, no clock dependency.
   *
   * Side effect: extends the "pair window open" admission window. The
   * menubar's PairView calls this on open and again every 2.5min while
   * the window stays visible, which keeps unknown pubkeys admittable
   * over the same window. Closing the pair window stops the refreshes;
   * admission lapses after `PAIR_WINDOW_MS` (5min) of silence.
   */
  createPairOffer(serviceName: string): { encoded: string };
  /**
   * Per-session runtime manager. Empty until slice G wires it into the
   * router; surfaced here so daemon.stop() can drain it on shutdown and
   * tests can inspect it.
   */
  readonly runtimeManager: SessionRuntimeManager<EventDelta>;
  /**
   * CCR bridge mirror service (slice M1). Owns the OAuthRefreshManager + all
   * live BridgeTransports. Surfaced so the M1.5 spike (and future RPC wiring
   * in M4) can `attach` sessions, and so daemon.stop() drains it. Empty in
   * normal operation until a session is bridged.
   */
  readonly bridgeService: BridgeService;
}

/**
 * How long after the most recent `createPairOffer()` call we still admit
 * unknown client pubkeys via the signaling worker. Tied to the menubar
 * PairView's 2.5min refresh cadence — one missed refresh keeps the window
 * open, two consecutive misses (= window closed for ≥ 5min) closes it.
 */
const PAIR_WINDOW_MS = 5 * 60_000;

export async function start(options: DaemonOptions = {}): Promise<Daemon> {
  const home = options.homeDir ?? resolveSidecodeHome();
  const identity = loadOrCreateIdentity(home);
  const knownClients = KnownClients.load(home);

  // Auto-tracked pair-window admission gate (see PAIR_WINDOW_MS comment).
  // `0` = never opened; `createPairOffer` writes the current time on each
  // call. `WebRTCPeerServer.isPairing` reads this on every `peer.joined`.
  let lastPairOfferAt = 0;

  // Lazy-populated by slice G's router when it sees its first sendPrompt.
  // Drained on shutdown via daemon.stop() → runtimeManager.shutdown().
  // `foldDelta` wires the continuous-fold reducer so each runtime keeps its
  // in-memory `settled` snapshot current as events fan out (no per-turn
  // JSONL re-read — see messages/fold.ts). `log` plumbs M3.7 teardown
  // structured-log events ("[teardown] armed/canceled/fired ...") through
  // the same `[sidecode]` stdout channel everything else uses.
  const runtimeManager = new SessionRuntimeManager<EventDelta>({
    foldDelta: foldEventDelta,
    log: (msg) => console.log(`[sidecode] ${msg}`),
  });
  // #17 — bind the sidecode home so the manager can read disk metadata
  // for `getAllSessionStates` (subscribeSessions initial snapshot) AND
  // persist `lastActivityAt` via `updateSidecodeSessionLastActivity` on
  // each activity edge. Tests use a memory-only manager (no setHome)
  // and skip the persistence path.
  runtimeManager.setHome(home);
  // CCR bridge mirror service (slice M1). One OAuthRefreshManager (the
  // keychain token is process-global) feeds every bridge; BridgeService
  // ref-counts its proactive timer to live only while ≥1 bridge is attached.
  // Drained in daemon.stop() AFTER runtimeManager.shutdown() so no late
  // forwardToBridge write races the transport close.
  //
  // Lifted out so the M3.4 startup-reattach orchestrator below shares the
  // SAME OAuth instance — the keychain token is process-global, and a
  // duplicate manager would double-refresh.
  const oauth = new OAuthRefreshManager();
  const bridgeService = new BridgeService({
    oauth,
    home,
    log: (message) => console.log(`[sidecode] ${message}`),
    // M2.2 read-in: a claude.ai-typed prompt → drive this session's local
    // turn. The reply streams back via M1's write-out tap; reusing the
    // inbound uuid makes the synthesized user_message's write-back fold
    // against claude.ai's own copy (dedup-by-uuid verified — no double
    // bubble, no origin tracking). Wiring this also flips every attached
    // transport to bidirectional.
    onInboundPrompt: (sessionId, prompt) => {
      const runtime = runtimeManager.get(sessionId);
      if (runtime === undefined) {
        // No local runtime for this bridged session. Linking a cse_ to a
        // local runtime + spawning its loop is M3 (create-bridged / startup
        // re-attach); until then there's nothing local to drive.
        console.log(
          `[sidecode] bridge inbound for session ${sessionId} with no runtime — dropped`,
        );
        return;
      }
      // Ensure a query loop, then feed the prompt. ensureSessionLoop is
      // idempotent (no-op if already running) and sets inputChannel
      // synchronously, so the immediately-following pushPrompt always finds
      // a live channel. resume mode: a bridged session taking claude.ai
      // prompts has cloud history; the local create-vs-resume + cwd-from-cse
      // refinement is M3. pushPrompt is UNCHANGED from the local/iOS path —
      // bridge / local / iOS prompts share one code path.
      try {
        ensureSessionLoop(runtime, { mode: "resume" });
        pushPrompt(runtime, prompt.text, prompt.images, prompt.uuid);
      } catch (err) {
        console.log(
          `[sidecode] bridge inbound prompt failed for ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    // M2.4 control routing: claude.ai pressed stop. Mirror of router's
    // `interrupt` RPC handler (router.ts):
    //   1. Synchronously mark `runtime.interrupted = true` BEFORE the await —
    //      the SDK ends an interrupted turn with `error_during_execution`,
    //      which handleResultEnvelope swallows when this flag is set so it
    //      isn't surfaced as a spurious turn_failed.
    //   2. await query.interrupt().
    //   3. addEvent({ kind: "turn_canceled" }) — so WebRTC subscribers see
    //      the cancel immediately. NOT mirrored to bridge (not in
    //      forwardToBridge allowlist), which is correct: claude.ai initiated
    //      the interrupt + SDK already auto-sent control_response:success;
    //      its spinner closes on the next `result` envelope via sendResult().
    // Best-effort: no live query → silent no-op (matches router's interrupt
    // semantics). Errors are logged but never propagate (would crash the
    // SDK's SSE read loop otherwise; the transport's try/catch is a 2nd net).
    onInterrupt: async (sessionId) => {
      const runtime = runtimeManager.get(sessionId);
      if (!runtime?.query) return;
      try {
        runtime.interrupted = true;
        await runtime.query.interrupt();
        runtime.addEvent({ kind: "turn_canceled" });
      } catch (err) {
        console.log(
          `[sidecode] bridge interrupt failed for ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    // M2.4 control routing: claude.ai changed the model. Mirror of router's
    // `setSessionSelection` RPC handler:
    //   1. apply to the live query via applyFlagSettings({model}) — per
    //      upstream docs this behaves identically to the dedicated setModel().
    //   2. persist via updateSidecodeSessionSelection — the iOS model chip
    //      reads SessionInfo.model (NOT transcript), so persisting is what
    //      makes the chip converge on next list-refresh / re-subscribe. Live
    //      cross-client model-change broadcast is deferred to #17 (the
    //      session control-state channel).
    //   3. SDK auto-sends control_response:success — we owe no response.
    // Order matters: apply first, persist second — if apply throws (model
    // not allowed by the account, etc.), metadata stays untouched so disk
    // doesn't drift from what the live query actually has. `undefined` model
    // means reset to default; applyFlagSettings handles it. No EventDelta
    // is emitted (model is per-turn fact carried on `message.model`, not
    // per-session state — see issue #17 for the long-term control channel).
    onSetModel: async (sessionId, model) => {
      const runtime = runtimeManager.get(sessionId);
      try {
        if (runtime?.query?.applyFlagSettings) {
          await runtime.query.applyFlagSettings({ model });
        }
        // #17 — mirror onto the runtime so a claude.ai-driven model
        // change broadcasts to every iOS subscribeSessions listener too
        // (otherwise iOS only sees the change after a list refresh).
        // Map undefined → null per the protocol's `model: string | null`.
        if (runtime !== undefined) {
          runtime.setModel(model ?? null);
        }
        updateSidecodeSessionSelection(home, sessionId, { model });
      } catch (err) {
        console.log(
          `[sidecode] bridge setModel failed for ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  });
  // Set in daemon.stop() before runtimeManager.shutdown(). Router gates
  // sendPrompt behind it (see RouterDeps.isShuttingDown rationale).
  let shuttingDown = false;
  // One GitWatcher per cwd, shared across all connections + sessions.
  // Disposed on daemon.stop() to release fs.watch handles cleanly.
  const gitWatchers = new GitWatcherRegistry();

  // Process-wide epoch nonce. Stable for the daemon's lifetime — every
  // subscribe.response carries this so iOS can pass it back as
  // `sinceEpoch` on reconnect. A mismatch tells the daemon it cannot
  // serve an incremental resume (the runtime ring buffers are fresh)
  // and to fall back to the cold-path full snapshot. See RouterDeps.epoch
  // for the longer rationale. UUID is plenty of entropy; we never log
  // or surface this to the user.
  const epoch = randomUUID();

  const commandHandler = createCommandHandler({
    continueOnDesktop,
    listSessions: listDesktopSessions,
    getMessages: async (cliSessionId, cwd) => {
      // `cwd` is a hint only — when undefined we let the SDK scan every
      // project key. Fork sessions in worktrees may have their JSONL at
      // the worktree's project key OR at originCwd's; the rule isn't
      // deterministic, so iOS omits the hint and we eat the ~20-stat scan
      // rather than mis-route.
      const sdkMessages = await getSessionMessages(
        cliSessionId,
        // `cwd` is a hint only — when undefined the SDK scans every
        // project key (robust for fork sessions where the JSONL location
        // isn't deterministic).
        cwd === undefined ? undefined : { dir: cwd },
        // Deliberately NOT passing `includeSystemMessages: true`. The
        // flag returns system messages but SDK's AH mapper strips
        // `subtype` + `compactMetadata`, leaving anonymous
        // `{type:'system', uuid, ...}` envelopes we can't act on (can't
        // tell compact_boundary from stop_hook_summary). Resume gets
        // no compact_divider for V0; live path emits dividers via
        // run-query.ts handling SDKCompactBoundaryMessage directly,
        // which still has the typed fields. See sidecodeapp/sidecode#13
        // for the long-term fix (self-built session reader that
        // preserves these fields off the raw JSONL).
      );
      // Two derivations from the same SDK call (no duplicate JSONL
      // read): the normalized timeline iOS renders, and the resume-
      // time usage seed for the context meter. extractLatestUsage
      // works on the raw SDK shape — must run BEFORE normalize() (which
      // discards the .message envelope where usage lives).
      return {
        items: normalize(sdkMessages),
        initialUsage: extractLatestUsage(sdkMessages),
      };
    },
    runtimeManager,
    hasSession: async (cliSessionId) => {
      const info = await getSessionInfo(cliSessionId);
      return info !== undefined;
    },
    listSidecodeSessions: (opts) => listSidecodeSessions(home, opts),
    writeSidecodeSession: ({ cliSessionId, cwd, firstPrompt, model }) => {
      writeSidecodeSession(
        home,
        buildNewSidecodeSession({
          cliSessionId,
          cwd,
          firstPrompt,
          model,
        }),
      );
    },
    updateSidecodeSessionSelection: ({ cliSessionId, model }) => {
      updateSidecodeSessionSelection(home, cliSessionId, { model });
    },
    isShuttingDown: () => shuttingDown,
    gitWatchers,
    epoch,
  });

  const webrtc = new WebRTCPeerServer({
    identity,
    knownClients,
    commandHandler,
    isPairing: () => Date.now() - lastPairOfferAt < PAIR_WINDOW_MS,
    signalingHost: options.signalingHost,
    signalingScheme: options.signalingScheme,
    log: (event, data) =>
      console.log(
        `[sidecode] ${event}${data ? ` ${JSON.stringify(data)}` : ""}`,
      ),
  });
  webrtc.start();

  // M3.4 startup re-attach (M3.6 SCOPE — includes archived sessions). Scan
  // sidecode metadata for any session with a `bridge` field and revive the
  // BridgeTransport. Fire-and-forget: daemon shouldn't block iOS accept on
  // a (potentially slow) cloud probe per bridged session. iOS subscribe
  // doesn't depend on bridge state — a not-yet-re-attached session behaves
  // like a never-bridged session until the orchestrator catches up; once
  // attached, the inbound prompt handler above starts driving incoming
  // claude.ai messages.
  //
  // No `await` here: a serial multi-session probe could take several
  // seconds and we want the WebRTC peer server to start accepting iOS
  // connections immediately. Errors within a single session don't propagate
  // out of the orchestrator (each session is independently classified +
  // logged); the overall promise should not reject under normal conditions.
  void reattachBridgedSessions({
    home,
    runtimeManager,
    bridgeService,
    oauth,
    log: (msg) => console.log(`[sidecode] ${msg}`),
  })
    .then((summary) => console.log(`[sidecode] ${summarizeReattach(summary)}`))
    .catch((err) =>
      console.log(
        `[sidecode] [bridge] startup re-attach unexpectedly rejected: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );

  // Advertise that we're running so `sidecode pair` (and the menubar) can
  // mint offers without spawning their own daemon. Address fields are
  // gone — the menubar reaches the daemon via the in-process function
  // call surface above, and the CLI does the same via the spawned-process
  // model. The lock just records "a daemon owns this $SIDECODE_HOME".
  writeDaemonLock(home, {
    pid: process.pid,
    startedAt: Date.now(),
  });

  // Best-effort sync cleanup: if our parent kills us ungracefully (signal
  // not delivered to handler, hard SIGKILL elsewhere), we still try to
  // remove the lock here. `pair-command` falls back to PID liveness check
  // so a leftover lock file is harmless either way — it'd just be
  // recognized as stale.
  process.on("exit", () => deleteDaemonLock(home));

  console.log(
    `sidecode daemon (protocol ${PROTOCOL_VERSION}) connecting to signaling.sidecode.app`,
  );
  console.log(`fingerprint: ${identity.fingerprint}`);
  console.log(`paired clients: ${knownClients.list().length}`);

  return {
    fingerprint: identity.fingerprint,
    pairedClientCount: () => knownClients.list().length,
    authenticatedPeerCount: () => webrtc.authenticatedCount(),
    createPairOffer: (serviceName) => {
      lastPairOfferAt = Date.now();
      const { encoded } = createPairOffer(identity, serviceName);
      return { encoded };
    },
    runtimeManager,
    bridgeService,
    async stop() {
      // Flip the gate FIRST so any inflight subscribe / sendPrompt RPC
      // racing with shutdown gets rejected before it can spawn a runtime
      // we won't drain.
      shuttingDown = true;
      // Drain SDK queries first so each subprocess gets the chance to
      // finish its current JSONL write before the transport tears down
      // and the process exits. SDK's `close()` triggers an internal 5s
      // grace; per-runtime timeoutMs caps how long we wait per session.
      // bin/sidecode.ts's outer 10s forceExit guards against catastrophic
      // hangs from there.
      await runtimeManager.shutdown(5000);
      // Close all CCR bridge mirrors + stop the OAuth refresh timer AFTER
      // the queries are drained — so no in-flight forwardToBridge write
      // races a transport close. Synchronous (just handle.close() per
      // bridge + clearTimeout); no await needed.
      bridgeService.shutdown();
      // Release fs.watch handles + cached SimpleGit instances; safe to
      // call before or after webrtc.stop(), no interaction with peers.
      gitWatchers.disposeAll();
      deleteDaemonLock(home);
      await webrtc.stop();
      console.log("sidecode daemon stopped");
    },
  };
}
