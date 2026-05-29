import { QueryClient } from "@tanstack/react-query";

/**
 * One QueryClient for the app's lifetime. Lives in its own module (not
 * inside _layout) so module-scope consumers — notably the sessions
 * TanStack DB collection in `sessions-collection.ts`, which needs a
 * QueryClient at construction time, outside any React tree — can share
 * the exact same instance the `<QueryClientProvider>` uses.
 *
 * Defaults are deliberately quiet: V0 fetches are cheap and daemon push
 * events (W3) will eventually drive cache freshness, so polling-style
 * refetch isn't needed.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
