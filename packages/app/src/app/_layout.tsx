import "@/global.css";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaListener } from "react-native-safe-area-context";
import { Uniwind } from "uniwind";
import {
  DaemonClientProvider,
  useDaemonClient,
} from "@/lib/daemon-client-context";
import { SafeAreaView } from "@/lib/styled";

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
          <SafeAreaListener
            onChange={({ insets }) => {
              Uniwind.updateInsets(insets);
            }}
          >
            <BottomSheetModalProvider>
              <DaemonGate>
                <Stack />
              </DaemonGate>
            </BottomSheetModalProvider>
          </SafeAreaListener>
        </DaemonClientProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

// Splash gate. Two concerns are intentionally separate:
//
//   - `isInitialized` — sticky flag, "have we ever connected this launch?"
//     Drives the splash branch. Native splash is one-shot; once we hide it,
//     we never re-show it on later reconnects.
//   - `isLoading` / `error` — the live status. Used for the first-attempt
//     error UI and to drive the Retry button's pending state.
//
// Once initialized, the Stack always renders. Reconnects don't gate the UI;
// downstream consumers can opt into a banner via useDaemonClient().isLoading.
function DaemonGate({ children }: { children: React.ReactNode }) {
  const { isInitialized, isLoading, error, reset } = useDaemonClient();

  useEffect(() => {
    // Hide as soon as we have something user-meaningful to render — either
    // the app (initialized) or the first-attempt error screen.
    if (isInitialized || error) {
      SplashScreen.hideAsync().catch(() => undefined);
    }
  }, [isInitialized, error]);

  if (!isInitialized) {
    if (error) {
      return (
        <ConnectError
          message={error.message}
          onRetry={reset}
          retrying={isLoading}
        />
      );
    }
    // Pre-init, no error yet → behind the native splash.
    return null;
  }

  return <View className="flex-1">{children}</View>;
}

function ConnectError({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <SafeAreaView className="flex-1 items-center justify-center bg-white px-6 dark:bg-black">
      <Text className="text-base font-medium text-red-600 dark:text-red-400">
        Couldn't connect to daemon
      </Text>
      <Text className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">
        {message}
      </Text>
      <Pressable
        onPress={onRetry}
        disabled={retrying}
        className="mt-5 rounded-md bg-gray-900 px-4 py-2 dark:bg-gray-100"
        style={retrying ? { opacity: 0.5 } : undefined}
      >
        <Text className="text-sm font-medium text-white dark:text-black">
          {retrying ? "Retrying…" : "Retry"}
        </Text>
      </Pressable>
    </SafeAreaView>
  );
}
