import {
  getSessionInfo,
  getSessionMessages,
} from "@anthropic-ai/claude-agent-sdk";
import { type EventDelta, PROTOCOL_VERSION } from "@sidecodeapp/protocol";
import { deleteDaemonLock, writeDaemonLock } from "./daemon-lock.js";
import { continueOnDesktop } from "./desktop/continue-on-desktop.js";
import { listDesktopSessions } from "./desktop/sessions.js";
import { resolveSidecodeHome } from "./home.js";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { normalize } from "./messages/normalize.js";
import { PairingService } from "./pairing.js";
import { createCommandHandler } from "./router.js";
import { SessionRuntimeManager } from "./runtime/session-runtime-manager.js";
import {
  buildNewSidecodeSession,
  writeSidecodeSession,
} from "./sidecode-sessions.js";
import { DEFAULT_HOST, DEFAULT_PORT, WebSocketServer } from "./ws-server.js";

export interface DaemonOptions {
  port?: number;
  host?: string;
  /** Address advertised in pair.offer (defaults to ws://<host>:<port>). */
  daemonAddress?: string;
  /** Override SIDECODE_HOME. */
  homeDir?: string;
}

export interface Daemon {
  stop(): Promise<void>;
  /** The host/port the WS server actually bound to. */
  readonly address: { host: string; port: number };
  /** Identity fingerprint, for status / pair display. */
  readonly fingerprint: string;
  /** Number of paired clients in known_clients.json (snapshot). */
  pairedClientCount(): number;
  /** Number of currently authenticated WS connections. */
  authenticatedConnectionCount(): number;
  /**
   * Per-session runtime manager. Empty until slice G wires it into the
   * router; surfaced here so daemon.stop() can drain it on shutdown and
   * tests can inspect it.
   */
  readonly runtimeManager: SessionRuntimeManager<EventDelta>;
}

export async function start(options: DaemonOptions = {}): Promise<Daemon> {
  const home = options.homeDir ?? resolveSidecodeHome();
  const identity = loadOrCreateIdentity(home);
  const knownClients = KnownClients.load(home);
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const daemonAddress = options.daemonAddress ?? `ws://${host}:${port}`;

  const pairing = new PairingService(identity, knownClients, { daemonAddress });
  // Lazy-populated by slice G's router when it sees its first sendPrompt.
  // Drained on shutdown via daemon.stop() → runtimeManager.shutdown().
  const runtimeManager = new SessionRuntimeManager<EventDelta>();
  // Set in daemon.stop() before runtimeManager.shutdown(). Router gates
  // sendPrompt behind it (see RouterDeps.isShuttingDown rationale).
  let shuttingDown = false;

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
        cwd === undefined ? undefined : { dir: cwd },
      );
      // normalize() flattens ContentBlock[] and pairs tool_use+tool_result
      // into TimelineItem[]. See desktop/normalize.ts for the per-tool
      // detail variants.
      return normalize(sdkMessages);
    },
    runtimeManager,
    hasSession: async (cliSessionId) => {
      const info = await getSessionInfo(cliSessionId);
      return info !== undefined;
    },
    writeSidecodeSession: ({ cliSessionId, cwd }) => {
      writeSidecodeSession(
        home,
        buildNewSidecodeSession({ cliSessionId, cwd }),
      );
    },
    isShuttingDown: () => shuttingDown,
  });
  const ws = new WebSocketServer({
    pairing,
    commandHandler,
    port,
    host,
    log: (event, data) =>
      console.log(
        `[sidecode] ${event}${data ? ` ${JSON.stringify(data)}` : ""}`,
      ),
  });
  const bound = await ws.start();

  // Advertise where we're listening so `sidecode pair` (and the future menu
  // bar) can read it without us writing yet another IPC channel.
  writeDaemonLock(home, {
    pid: process.pid,
    // If the user passed 0.0.0.0 or 127.0.0.1, prefer 127.0.0.1 in the
    // advertised host so locally-running CLI tools don't have to guess.
    host: bound.host === "0.0.0.0" ? "127.0.0.1" : bound.host,
    port: bound.port,
    startedAt: Date.now(),
  });

  // Best-effort sync cleanup: if our parent kills us ungracefully (signal
  // not delivered to handler, hard SIGKILL elsewhere), we still try to
  // remove the lock here. `pair-command` falls back to PID liveness check
  // so a leftover lock file is harmless either way — it'd just be
  // recognized as stale.
  process.on("exit", () => deleteDaemonLock(home));

  console.log(
    `sidecode daemon (protocol ${PROTOCOL_VERSION}) listening on ws://${bound.host}:${bound.port}`,
  );
  console.log(`fingerprint: ${identity.fingerprint}`);
  console.log(`paired clients: ${knownClients.list().length}`);

  return {
    address: bound,
    fingerprint: identity.fingerprint,
    pairedClientCount: () => knownClients.list().length,
    authenticatedConnectionCount: () => ws.authenticatedCount(),
    runtimeManager,
    async stop() {
      // Flip the gate FIRST so any inflight subscribe / sendPrompt RPC
      // racing with shutdown gets rejected before it can spawn a runtime
      // we won't drain.
      shuttingDown = true;
      // Drain SDK queries first so each subprocess gets the chance to
      // finish its current JSONL write before the ws server tears down
      // and the process exits. SDK's `close()` triggers an internal 5s
      // grace; per-runtime timeoutMs caps how long we wait per session.
      // bin/sidecode.ts's outer 10s forceExit guards against catastrophic
      // hangs from there.
      await runtimeManager.shutdown(5000);
      deleteDaemonLock(home);
      await ws.stop();
      console.log("sidecode daemon stopped");
    },
  };
}
