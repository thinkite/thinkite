import { focusManager, QueryClient } from "@tanstack/react-query";

// Server state the bus doesn't push — the repository of a session's folder,
// the model catalog, what Settings shows — cached by key, so a screen that
// mounts again (each session screen is keyed by its id) shows the last
// answer while it reads again instead of starting empty. Sessions, their
// messages and their requests are pushed, and live in the oc-client store.
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 0, retry: 1 } },
});

// Query reads again when the page becomes visible, but switching apps
// leaves an Electron window visible; window focus is the signal here.
focusManager.setEventListener((setFocused) => {
  const onFocus = () => setFocused(true);
  const onBlur = () => setFocused(false);
  window.addEventListener("focus", onFocus);
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("focus", onFocus);
    window.removeEventListener("blur", onBlur);
  };
});

/**
 * Keys of the reads about the service's providers, accounts and models, all
 * under `["catalog"]`: they change only when the bus says so (lib/oc), so
 * they never go stale on their own.
 */
export const catalogKeys = {
  all: ["catalog"] as const,
  models: ["catalog", "models"] as const,
  defaultModel: (directory: string) =>
    ["catalog", "default-model", directory] as const,
  integrations: ["catalog", "integrations"] as const,
};

/** Read every catalog query again (a provider was connected, say). */
export const invalidateCatalog = () =>
  queryClient.invalidateQueries({ queryKey: catalogKeys.all });

/** Keys of Settings › Extensions' reads, all under `["extensions"]`: read
 *  again on the bus's plugin, config, MCP and skill events (lib/oc). */
export const extensionKeys = {
  all: ["extensions"] as const,
  plugins: ["extensions", "plugins"] as const,
  mcp: ["extensions", "mcp"] as const,
  skills: ["extensions", "skills"] as const,
  /** Asks the npm registry, so it stays out of `all`: read on opening the
   *  page and after an install or update, not on every config change. */
  pluginUpdates: ["plugin-updates"] as const,
};

export const invalidateExtensions = () =>
  queryClient.invalidateQueries({ queryKey: extensionKeys.all });

/** The attached service's identity and version: the sidebar's footer and
 *  Settings share one read. */
export const serviceInfoKey = ["service", "info"] as const;

/** Keys of the repository reads, all under `["vcs", directory]`. */
export const vcsKeys = {
  all: (directory: string) => ["vcs", directory] as const,
  info: (directory: string) => ["vcs", directory, "info"] as const,
  diff: (directory: string, context?: number) =>
    ["vcs", directory, "diff", "branch", context ?? null] as const,
};
