import { PROTOCOL_VERSION } from "@sidecodeapp/protocol";
import { resolveSidecodeHome } from "./home.js";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { PairingService } from "./pairing.js";
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
  const ws = new WebSocketServer({
    pairing,
    port,
    host,
    log: (event, data) =>
      console.log(`[sidecode] ${event}${data ? ` ${JSON.stringify(data)}` : ""}`),
  });
  const bound = await ws.start();

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
      await ws.stop();
      console.log("sidecode daemon stopped");
    },
  };
}
