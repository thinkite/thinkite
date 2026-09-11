import { createOcClient, type OcClient, SharedBus } from "@thinkite/oc-client";
import {
  createSessionsCollection,
  createTranscriptCollections,
} from "@thinkite/oc-client/tanstack";

// Renderer-wide opencode v2 access. Same-origin `/oc` (the Electron main
// reverse proxy injects Basic auth — credentials never reach this process),
// so one client serves the whole app.
//
// Subscriptions: each open session owns ONE durable stream (`after=`
// resume on reconnect, owned by its transcript collection); the global
// bus (`/api/event`: live-only deltas, session.status, session
// create/update/delete, permission/question asks) is a SINGLE shared
// async-iterator fan-out — every session stream needs the bus fragments
// routed by `sessionID`, and the session list needs the same bus. One
// connection, many subscribers; reconnects re-issue with backoff in the
// collection sync handlers, not here.

let client: OcClient | null = null;

export function getOcClient(): OcClient {
  if (client === null) {
    client = createOcClient({ baseUrl: `${location.origin}/oc` });
  }
  return client;
}

export const sharedOcBus = new SharedBus(() => getOcClient());

// Collection singletons created once from the `./tanstack` factories: one
// sessions collection and one transcript cache per app — so the sidebar,
// route loaders, and transcript all share one sync handler (and one
// durable stream per open session).
export const sessionStateCollection = createSessionsCollection({
  client: getOcClient(),
  bus: sharedOcBus,
});

export const {
  get: getTranscriptCollection,
  evict: evictTranscriptCollection,
  sendUserMessage,
} = createTranscriptCollections({ client: getOcClient(), bus: sharedOcBus });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // HMR hygiene: drop the singleton + bus so a hot-swapped module
    // instance doesn't leave a zombie stream (same dance as daemon-rpc).
    client = null;
  });
}
