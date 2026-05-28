import { randomUUID } from "node:crypto";
import {
  getSessionInfo,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { type EventDelta, PROTOCOL_VERSION } from "@sidecodeapp/protocol";
import { deleteDaemonLock, writeDaemonLock } from "./daemon-lock.js";
import { continueOnDesktop } from "./desktop/continue-on-desktop.js";
import { listDesktopSessions } from "./desktop/sessions.js";
import { GitWatcherRegistry } from "./git-watch.js";
import { resolveSidecodeHome } from "./home.js";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { extractLatestUsage, normalize } from "./messages/normalize.js";
import { createPairOffer } from "./pairing.js";
import { createCommandHandler } from "./router.js";
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
  const runtimeManager = new SessionRuntimeManager<EventDelta>();
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
      // Release fs.watch handles + cached SimpleGit instances; safe to
      // call before or after webrtc.stop(), no interaction with peers.
      gitWatchers.disposeAll();
      deleteDaemonLock(home);
      await webrtc.stop();
      console.log("sidecode daemon stopped");
    },
  };
}
