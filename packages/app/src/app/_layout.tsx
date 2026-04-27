import "@/global.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { HeroUINativeProvider } from "heroui-native";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaView } from "react-native-safe-area-context";
import {
  DaemonClientProvider,
  useDaemonClient,
} from "@/lib/daemon-client-context";

// Hold the native splash open through the daemon handshake. Per Expo docs,
// preventAutoHideAsync MUST run in module scope (not inside a hook) — by the
// time a useEffect fires, the splash has already auto-hidden.
SplashScreen.preventAutoHideAsync().catch(() => undefined);
SplashScreen.setOptions({ duration: 200, fade: true });

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
            <DaemonGate>
              <Stack />
            </DaemonGate>
          </HeroUINativeProvider>
        </DaemonClientProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

// Native splash stays up while the daemon is connecting. When the handshake
// settles (success or error) we hide it, revealing either the Stack or the
// inline error UI below.
//
// The native splash is one-shot per launch, so a later `reset()` (Retry)
// briefly renders blank during reconnect — acceptable for V0; we can add an
// inline spinner if it ever feels rough.
function DaemonGate({ children }: { children: React.ReactNode }) {
  const { isLoading, error, reset } = useDaemonClient();

  useEffect(() => {
    if (!isLoading) SplashScreen.hideAsync().catch(() => undefined);
  }, [isLoading]);

  if (isLoading) return null;

  if (error) {
    return (
      <SafeAreaView className="flex-1 items-center justify-center bg-white px-6 dark:bg-black">
        <Text className="text-base font-medium text-red-600 dark:text-red-400">
          Couldn't connect to daemon
        </Text>
        <Text className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">
          {error.message}
        </Text>
        <Pressable
          onPress={reset}
          className="mt-5 rounded-md bg-gray-900 px-4 py-2 dark:bg-gray-100"
        >
          <Text className="text-sm font-medium text-white dark:text-black">
            Retry
          </Text>
        </Pressable>
      </SafeAreaView>
    );
  }

  return <View className="flex-1">{children}</View>;
}
