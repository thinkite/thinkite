import {
  createOcClient,
  createOcStore,
  type OcClient,
} from "@thinkite/oc-client";
import { useEffect } from "react";
import type { BiStreamLike } from "react-native-iroh-ffi";
import { getPairedDaemon } from "./daemon-client";
import { useDaemonClient } from "./daemon-client-context";
import { loadOrCreateIdentity } from "./identity";
import { createIrohFetch } from "./iroh-fetch";
import { closeHttpConnection, openHttpStream } from "./iroh-wire";

// Phone-side opencode 2 access — the phone twin of
// packages/desktop/src/lib/oc.ts. Desktop is same-origin through the
// Electron `/oc` proxy; the phone tunnels HTTP/1.1 over iroh
// (`thinkite/http/1`) with the fetch shim in iroh-fetch.ts, so the
// generated client, its SSE parser, and the oc-client store run unchanged.
// Basic auth is injected by the daemon's proxy end.
//
// Connection gate: unlike desktop, the tunnel is only reachable while the
// daemon RPC connection is online (pairing + endpoint reachability), so
// `OcRuntimeGate` (mounted in the root layout) starts the store on the
// first `online`; later offline blips only drop the cached tunnel
// connection.

const DEV_BASE_URL = process.env.EXPO_PUBLIC_OC_BASE_URL;

/** Placeholder origin — only the path goes on the wire. */
const TUNNEL_BASE_URL = "http://daemon.iroh";

/** Fresh bi-stream per request on the daemon's HTTP tunnel. */
async function openTunnelStream(): Promise<BiStreamLike> {
  const [identity, paired] = await Promise.all([
    loadOrCreateIdentity(),
    getPairedDaemon(),
  ]);
  if (paired === null) throw new Error("no paired daemon");
  return openHttpStream(identity, paired.daemonIdentityPublicKey);
}

let client: OcClient | null = null;

export function getOcClient(): OcClient {
  if (client === null) {
    client =
      DEV_BASE_URL !== undefined && DEV_BASE_URL !== ""
        ? // Dev override: the desktop's `/oc` loopback proxy (or any
          // direct opencode URL) through the global fetch.
          createOcClient({ baseUrl: DEV_BASE_URL })
        : createOcClient({
            baseUrl: TUNNEL_BASE_URL,
            fetch: createIrohFetch({ openStream: openTunnelStream }),
          });
  }
  return client;
}

export const ocStore = createOcStore({ client: getOcClient() });

/**
 * Start the opencode runtime: read the session list and follow the bus.
 * Idempotent. Called by `OcRuntimeGate` when the daemon connection is online.
 */
export function attachOcRuntime(): void {
  ocStore.start().catch((err: unknown) => {
    console.warn("[oc] session list read failed:", err);
  });
}

/**
 * Daemon went away: drop the cached tunnel connection so the next request
 * re-dials, and nothing else. The store stays up: its bus loop reconnects
 * with backoff and re-reads the list and open transcripts on
 * `server.connected`.
 */
export function detachOcRuntime(): void {
  closeHttpConnection();
}

/**
 * Headless gate mounted inside `DaemonClientProvider`. It owns the
 * opencode runtime lifecycle off the same `ConnectionStatus` the status
 * badge reads, so the bus and the store never start before the phone is
 * paired and online and re-open on every offline → online transition.
 */
export function OcRuntimeGate(): null {
  const { connectionStatus } = useDaemonClient();
  useEffect(() => {
    if (connectionStatus === "online") attachOcRuntime();
    else detachOcRuntime();
  }, [connectionStatus]);
  return null;
}
