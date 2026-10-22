import {
  createOcClient,
  createOcStore,
  type OcClient,
  subscribeEvents,
} from "@thinkite/oc-client";
import { invalidateCatalog } from "./query";

// Renderer-wide opencode 2 access. Same-origin `/oc` (the Electron main
// reverse proxy injects Basic auth — credentials never reach this process),
// so one client and one store serve the whole app. `pathPrefix` because the
// generated client resolves routes against the origin and would drop `/oc`.

export const ocClient: OcClient = createOcClient({
  baseUrl: location.origin,
  pathPrefix: "/oc",
});

export const ocStore = createOcStore({ client: ocClient });

/** Resolves once the session list is in; route loaders wait on it. */
export const ocReady = ocStore.start();
// A failed first read shows up in `ocStore.status`; loaders see it too.
ocReady.catch(() => {});

// Whenever the service's providers, accounts or models change, on the
// events opencode's own client re-reads them on, the catalog queries
// (the model picker, Settings › Providers; lib/query) read again.
const CATALOG_EVENTS = new Set([
  "integration.updated",
  "provider.updated",
  "model.updated",
  "credential.updated",
  "credential.switched",
]);
// A second subscriber on the client's one shared event stream.
const catalogBus = new AbortController();
void subscribeEvents(
  ocClient,
  (event) => {
    if (CATALOG_EVENTS.has(event.type)) void invalidateCatalog();
  },
  { signal: catalogBus.signal, onError: () => {} },
);

if (import.meta.hot) {
  // HMR hygiene: a hot-swapped module instance must not leave a zombie bus.
  import.meta.hot.dispose(() => {
    ocStore.stop();
    catalogBus.abort();
  });
}
