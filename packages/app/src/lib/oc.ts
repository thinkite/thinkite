import { createOcClient, type OcClient } from "@thinkite/oc-client";
import {
  createSessionsCollection,
  createTranscriptCollections,
} from "@thinkite/oc-client/tanstack";
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
// generated client, its SSE parser, and the oc-client reducers run
// unchanged. Basic auth is injected by the daemon's proxy end.
//
// Subscriptions mirror desktop: the collections share one `/api/event`
// connection (fan-out inside `@opencode/client`) and resync on every
// `server.connected`.
//
// Connection gate: unlike desktop, the tunnel is only reachable while the
// daemon RPC connection is online (pairing + endpoint reachability). This
// module therefore creates the collections with `startSync: false` and
// `OcRuntimeGate` (mounted in the root layout) starts them on the first
// `online`; later offline blips only drop the cached tunnel connection
// (see `detachOcRuntime` for why the collections stay alive).

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

// Collection singletons — same shapes as desktop, created once from the
// `./tanstack` factories. `startSync: false` on the sessions collection so
// it waits for the connection gate (the transcript factory is inert until
// first `get`).
export const sessionStateCollection = createSessionsCollection({
  client: getOcClient(),
  startSync: false,
});

const transcripts = createTranscriptCollections({ client: getOcClient() });

export const {
  get: getTranscriptCollection,
  paging: transcriptPaging,
  loadOlder: loadOlderTranscript,
  evict: evictTranscriptCollection,
  sendUserMessage,
} = transcripts;

/**
 * Start the opencode runtime — idempotent; the collection's sync handler
 * loads the session list, seeds turn state, and subscribes to the shared
 * bus. Called by `OcRuntimeGate` when the daemon connection is online.
 */
export function attachOcRuntime(): void {
  sessionStateCollection.startSyncImmediate();
}

/**
 * Daemon went away: drop the cached tunnel connection so the next request
 * re-dials, and nothing else. The collections are NOT cleaned up here —
 * TanStack DB throws ("Source collection … was manually cleaned up while
 * live query … depends on it") when a mounted `useLiveQuery` still holds
 * the collection, and the list screen is mounted through every
 * connecting/offline blip. The sync handlers already own their recovery:
 * every collection's bus loop reconnects with backoff and re-reads
 * its projection on `server.connected`. Observed on the simulator before this change:
 * cleanup/restart churn on the connecting→online edge, one Live Query
 * Error toast, and two proxied requests cut mid-flight (502 ECONNRESET).
 */
export function detachOcRuntime(): void {
  closeHttpConnection();
}

/**
 * Headless gate mounted inside `DaemonClientProvider`. It owns the
 * opencode runtime lifecycle off the same `ConnectionStatus` the status
 * badge reads, so the bus/collections never start before the phone is
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
