import { createOcClient, type OcClient } from "@thinkite/oc-client";
import {
  createSessionsCollection,
  createTranscriptCollections,
} from "@thinkite/oc-client/tanstack";

// Renderer-wide opencode 2 access. Same-origin `/oc` (the Electron main
// reverse proxy injects Basic auth — credentials never reach this process),
// so one client serves the whole app. `pathPrefix` because the generated
// client resolves routes against the origin and would drop `/oc`.
//
// Subscriptions: the collections share one `/api/event` connection
// (fan-out inside `@opencode/client`); reconnects and the resync on
// `server.connected` live in the collection sync handlers.

let client: OcClient | null = null;

export function getOcClient(): OcClient {
  if (client === null) {
    client = createOcClient({ baseUrl: location.origin, pathPrefix: "/oc" });
  }
  return client;
}

// Collection singletons created once from the `./tanstack` factories: one
// sessions collection and one transcript cache per app — so the sidebar,
// route loaders, and transcript all share one sync handler.
export const sessionStateCollection = createSessionsCollection({
  client: getOcClient(),
});

export const {
  get: getTranscriptCollection,
  paging: transcriptPaging,
  loadOlder: loadOlderTranscript,
  evict: evictTranscriptCollection,
  sendUserMessage,
} = createTranscriptCollections({ client: getOcClient() });

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    // HMR hygiene: drop the singleton so a hot-swapped module instance
    // doesn't leave a zombie stream (same dance as daemon-rpc).
    client = null;
  });
}
