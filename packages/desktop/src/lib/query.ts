import { focusManager, QueryClient } from "@tanstack/react-query";

// Server state the bus doesn't push — the repository of a session's folder,
// for now — cached by key, so a screen that mounts again (each session
// screen is keyed by its id) shows the last answer while it reads again
// instead of starting empty.
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

/** Keys of the repository reads, all under `["vcs", directory]`. */
export const vcsKeys = {
  all: (directory: string) => ["vcs", directory] as const,
  info: (directory: string) => ["vcs", directory, "info"] as const,
  diff: (directory: string, context?: number) =>
    ["vcs", directory, "diff", "branch", context ?? null] as const,
};
