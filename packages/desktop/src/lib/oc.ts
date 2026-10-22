import {
  createOcClient,
  createOcStore,
  type OcClient,
} from "@thinkite/oc-client";

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

if (import.meta.hot) {
  // HMR hygiene: a hot-swapped module instance must not leave a zombie bus.
  import.meta.hot.dispose(() => ocStore.stop());
}
