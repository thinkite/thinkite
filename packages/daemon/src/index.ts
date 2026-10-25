import { PROTOCOL_VERSION } from "@thinkite/protocol";
import { deleteDaemonLock, writeDaemonLock } from "./daemon-lock.ts";
import { GitWatcherRegistry } from "./git-watch.ts";
import { resolveThinkiteHome } from "./home.ts";
import { loadOrCreateIdentity } from "./identity.ts";
import { IrohPeerServer } from "./iroh-peer-server.ts";
import { KnownClients } from "./known-clients.ts";
import { listRecentSessions } from "./opencode/recent.ts";
import {
  createOpencodeDiscovery,
  isSupportedOpencodeVersion,
  OPENCODE_MIN_STABLE,
} from "./opencode/registry.ts";
import {
  createOpencodeStarter,
  type ResolveOpencode,
} from "./opencode/service.ts";
import { createPairOffer } from "./pairing.ts";
import { PreviewHost } from "./preview/host.ts";
import type { PreviewRegistry } from "./preview/registry.ts";
import { createCommandHandler } from "./router.ts";

export interface DaemonOptions {
  /** Override THINKITE_HOME. */
  homeDir?: string;
}

export type { DaemonLock } from "./daemon-lock.ts";

// Host-side single-instance guard: `start()` only WRITES the lock (liveness
// record); a host that may coexist with another daemon checks before
// starting.
export { readActiveDaemonLock } from "./daemon-lock.ts";
export { resolveThinkiteHome } from "./home.ts";
export type { OpencodeConnection } from "./opencode/registry.ts";
export { startsTask } from "./opencode/service.ts";
export type { PreviewOpened, PreviewRegistry } from "./preview/registry.ts";

export interface Daemon {
  stop(): Promise<void>;
  /** Identity fingerprint, for status / pair display. */
  readonly fingerprint: string;
  /** Number of paired clients in known_clients.json (snapshot). */
  pairedClientCount(): number;
  /** Number of currently authenticated remote peers. */
  authenticatedPeerCount(): number;
  /**
   * Mint a fresh pair offer pointing at this daemon. Pure: derived from the
   * daemon's identity + the given serviceName — no per-offer state, no
   * nonces, no clock dependency, NO side effects. The same daemon always
   * mints the same offer, so a caller can mint once and cache it.
   *
   * Admission is controlled separately via `setPairing` — minting an offer
   * does NOT open the gate.
   */
  createPairOffer(serviceName: string): { encoded: string };
  /**
   * Open / close the pair-window admission gate. While open, an unknown
   * client pubkey that connects is admitted to known_clients; while closed,
   * unknown pubkeys are rejected. The desktop flips this on the Pair
   * window's open/close — the window being visible IS the gate, so closing
   * it stops admitting new devices immediately (no trailing TTL).
   * Already-paired clients reconnect regardless of this flag.
   */
  setPairing(open: boolean): void;
  /**
   * Address + Basic credentials of the user's registered opencode 2
   * service (`~/.local/state/opencode/service.json`, probed via
   * `/api/info`, cached 5 s) for the Electron main `/oc` reverse proxy
   * and the phone's iroh HTTP tunnel. Rejects when no service is
   * registered or its version is outside the supported range. With
   * `start`, a missing service is started first (`opencode serve
   * --service`, see opencode/service.ts) — the proxies pass it for
   * requests that start a task. Credentials stay in the main process —
   * the proxies inject them, clients never see them.
   */
  opencode: ResolveOpencode;
  /**
   * Call `onChange` whenever the repository at `cwd` changes — the agent's
   * edits, a reset or a branch switch outside the app — through the same
   * watcher that pushes the phone's git status. Returns the unsubscribe.
   */
  watchGit(cwd: string, onChange: () => void): () => void;
  /**
   * Servers the agent started with the preview tools (`thinkite_preview_*`,
   * served to opencode over client MCP), per project directory. The phone
   * reaches the same registry through the RPC.
   */
  previews: PreviewRegistry;
}

/**
 * The Thinkite daemon: the phone's way in. It owns the pairing identity and
 * an iroh endpoint that carries two things — HTTP to the user's opencode
 * service (sessions, prompts, transcripts are all opencode's), and a small
 * RPC for what opencode does not offer the phone (git status and diffs,
 * the folder picker, version negotiation).
 */
export async function start(options: DaemonOptions = {}): Promise<Daemon> {
  const home = options.homeDir ?? resolveThinkiteHome();
  const identity = loadOrCreateIdentity(home);
  const knownClients = KnownClients.load(home);

  // Pair-window admission gate. The desktop flips this via `setPairing` on
  // the Pair window's open/close; `IrohPeerServer.isPairing` reads it on
  // every incoming connection. Closed by default — the window must be open
  // for an unknown pubkey to be admitted.
  //
  // THINKITE_PAIRING_OPEN=1 forces the gate open for the whole daemon
  // lifetime — dev/CLI affordance for pairing a fresh device when the
  // daemon runs headless via `thinkite up` (the CLI `pair` command
  // prints the QR from a separate process, so it can't flip the
  // in-process gate the way the menubar window does). Don't run a
  // long-lived daemon with this set: any device that scans the QR (or
  // learns the pubkey) gets admitted while it's up.
  let pairingOpen = process.env.THINKITE_PAIRING_OPEN === "1";
  if (pairingOpen) {
    console.log(
      "[thinkite] pairing gate FORCED OPEN via THINKITE_PAIRING_OPEN=1 — new devices will be admitted",
    );
  }

  // opencode 2 endpoint for the desktop `/oc` proxy and the phone's iroh
  // HTTP tunnel: the user's registered background service
  // (`~/.local/state/opencode/service.json`, see opencode/registry.ts).
  // Whoever needs it first starts that process — the desktop app, the TUI,
  // or this daemon when a task starts with none running; we attach with no
  // version pin, so an upgrade that replaces the service is picked up on
  // the next probe.
  const opencodeDiscovery = createOpencodeDiscovery({
    onChange: (next) =>
      console.log(
        `[thinkite] opencode service ${
          next === null
            ? "not registered"
            : `${next.version} pid ${next.pid} at ${next.baseUrl}${
                isSupportedOpencodeVersion(next.version)
                  ? ""
                  : ` (unsupported: need ≥ ${OPENCODE_MIN_STABLE} or a v2 beta)`
              }`
        }`,
      ),
  });
  const opencodeStarter = createOpencodeStarter({
    log: (message) => console.log(`[thinkite] ${message}`),
  });
  const resolveOpencode: ResolveOpencode = async ({ start = false } = {}) => {
    let discovered = await opencodeDiscovery.resolve();
    if (discovered === null && (start || opencodeStarter.pending() !== null)) {
      await opencodeStarter.start();
      opencodeDiscovery.invalidate();
      discovered = await opencodeDiscovery.resolve();
    }
    if (discovered === null) {
      throw new Error(
        "no opencode service is running — start the opencode desktop app or `opencode serve --service`",
      );
    }
    if (!isSupportedOpencodeVersion(discovered.version)) {
      throw new Error(
        `opencode ${discovered.version} is not supported — Thinkite needs opencode ≥ ${OPENCODE_MIN_STABLE} (or a v2 beta build)`,
      );
    }
    return discovered;
  };
  // One GitWatcher per cwd, shared across all connections.
  // Disposed on daemon.stop() to release fs.watch handles cleanly.
  const gitWatchers = new GitWatcherRegistry();

  // The agent's preview tools: one client-MCP connection per session
  // directory on the user's opencode service, plus the registry of the
  // servers they started (docs/preview-tool-v1.md).
  const previewHost = new PreviewHost({
    resolve: resolveOpencode,
    version: PROTOCOL_VERSION,
    log: (message) => console.log(`[thinkite] ${message}`),
  });
  previewHost.start();

  const commandHandler = createCommandHandler({
    gitWatchers,
    recentSessions: async () => listRecentSessions(await resolveOpencode()),
    previews: previewHost.registry,
  });

  // The remote transport: iroh QUIC listener on the pairing identity
  // (EndpointId == pairing pubkey). Failure to load the napi binding
  // (or to bind) degrades to a log line rather than crashing — the
  // desktop GUI does not need it — but remote clients can't connect until
  // the daemon restarts cleanly.
  const iroh = new IrohPeerServer({
    identity,
    knownClients,
    commandHandler,
    isPairing: () => pairingOpen,
    // HTTP tunnel target: the same registered opencode service the desktop
    // proxy uses, re-resolved per request (5 s discovery cache).
    opencode: resolveOpencode,
    log: (event, data) =>
      console.log(
        `[thinkite] ${event}${data ? ` ${JSON.stringify(data)}` : ""}`,
      ),
  });
  void iroh.start().catch((err: unknown) => {
    console.log(
      `[thinkite] iroh.unavailable — remote clients cannot connect: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  });

  // Advertise that we're running so `thinkite pair` can mint offers
  // without spawning its own daemon. The lock just records "a daemon owns
  // this $THINKITE_HOME".
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
    `thinkite daemon (protocol ${PROTOCOL_VERSION}) — iroh listener starting`,
  );
  console.log(`fingerprint: ${identity.fingerprint}`);
  console.log(`paired clients: ${knownClients.list().length}`);

  console.log(
    `thinkite daemon (protocol ${PROTOCOL_VERSION}) — iroh listener starting`,
  );
  console.log(`fingerprint: ${identity.fingerprint}`);
  console.log(`paired clients: ${knownClients.list().length}`);

  return {
    fingerprint: identity.fingerprint,
    pairedClientCount: () => knownClients.list().length,
    authenticatedPeerCount: () => iroh.authenticatedCount(),
    opencode: resolveOpencode,
    watchGit: (cwd, onChange) =>
      gitWatchers.getOrCreate(cwd).subscribe(() => onChange()),
    previews: previewHost.registry,
    createPairOffer: (serviceName) => {
      const { encoded } = createPairOffer(identity, serviceName);
      return { encoded };
    },
    setPairing: (open) => {
      pairingOpen = open;
    },
    async stop() {
      // Release fs.watch handles + cached SimpleGit instances; safe to
      // call before or after iroh.stop(), no interaction with peers.
      gitWatchers.disposeAll();
      previewHost.stop();
      deleteDaemonLock(home);
      await iroh.stop();
      console.log("thinkite daemon stopped");
    },
  };
}
