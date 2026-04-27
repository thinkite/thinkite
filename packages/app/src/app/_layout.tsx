import "@/global.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { HeroUINativeProvider } from "heroui-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { DaemonClientProvider } from "@/lib/daemon-client-context";

// One QueryClient for the app's lifetime. Defaults are deliberately quiet —
// V0 fetches are cheap and the daemon push events (W3) will eventually
// invalidate cache directly, so polling-style refetch isn't needed.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <DaemonClientProvider>
          <HeroUINativeProvider>
            <Stack />
          </HeroUINativeProvider>
        </DaemonClientProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
