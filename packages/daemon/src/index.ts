import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { PROTOCOL_VERSION, type SessionMessage } from "@sidecodeapp/protocol";
import { deleteDaemonLock, writeDaemonLock } from "./daemon-lock.js";
import { continueOnDesktop } from "./desktop/continue-on-desktop.js";
import { listDesktopSessions } from "./desktop/sessions.js";
import { resolveSidecodeHome } from "./home.js";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { PairingService } from "./pairing.js";
import { createCommandHandler } from "./router.js";
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
}

export async function start(options: DaemonOptions = {}): Promise<Daemon> {
  const home = options.homeDir ?? resolveSidecodeHome();
  const identity = loadOrCreateIdentity(home);
  const knownClients = KnownClients.load(home);
  const port = options.port ?? DEFAULT_PORT;
  const host = options.host ?? DEFAULT_HOST;
  const daemonAddress = options.daemonAddress ?? `ws://${host}:${port}`;

  const pairing = new PairingService(identity, knownClients, { daemonAddress });
  const commandHandler = createCommandHandler({
    continueOnDesktop,
    listSessions: listDesktopSessions,
    getMessages: async (cliSessionId, cwd) => {
      // SDK returns its own SessionMessage shape (`session_id`, plus a
      // `parent_tool_use_id` we don't ship). Reshape to our wire type:
      // camelCase the field, drop the always-null tool-use parent.
      const sdkMessages = await getSessionMessages(cliSessionId, { dir: cwd });
      return sdkMessages.map<SessionMessage>((m) => ({
        type: m.type,
        uuid: m.uuid,
        sessionId: m.session_id,
        message: m.message,
      }));
    },
  });
  const ws = new WebSocketServer({
    pairing,
    commandHandler,
    port,
    host,
    log: (event, data) =>
      console.log(`[sidecode] ${event}${data ? ` ${JSON.stringify(data)}` : ""}`),
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
    async stop() {
      deleteDaemonLock(home);
      await ws.stop();
      console.log("sidecode daemon stopped");
    },
  };
}
