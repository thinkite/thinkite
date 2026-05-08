import "@/global.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { useEffect } from "react";
import { Pressable, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import {
  SafeAreaListener,
  SafeAreaProvider,
} from "react-native-safe-area-context";
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
      <SafeAreaProvider>
        <KeyboardProvider>
          <QueryClientProvider client={queryClient}>
            <DaemonClientProvider>
              <SafeAreaListener
                onChange={({ insets }) => {
                  Uniwind.updateInsets(insets);
                }}
              >
                <DaemonGate>
                  <RootStack />
                </DaemonGate>
              </SafeAreaListener>
            </DaemonClientProvider>
          </QueryClientProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * Root Stack. Pair-vs-main routing is delegated to expo-router's
 * `Stack.Protected` guards — when `isUnpaired` flips, the router
 * auto-redirects to the next accessible screen:
 *
 *   isUnpaired = true   → only `pair` is reachable → user lands on /pair
 *   isUnpaired = false  → `(drawer)` + `settings` + `dev/diffs` reachable
 *                         → user lands on / (drawer index)
 *
 * Per expo-router docs, "if a screen becomes protected while it is
 * active, they will be redirected to the anchor route or the first
 * available screen in the stack" — so on first successful pair the user
 * is automatically taken from /pair to the drawer index without any
 * imperative `router.replace`.
 *
 * DaemonGate (below) still gates the entire Stack on `isInitialized`
 * to keep the native splash up until we know which side of the guard
 * the user belongs on.
 */
function RootStack() {
  const { isUnpaired } = useDaemonClient();
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={isUnpaired}>
        {/* First-launch / re-pair gate. Component lives in
            components/pair-screen.tsx; pair.tsx is just the route shell. */}
        <Stack.Screen name="pair" />
      </Stack.Protected>
      <Stack.Protected guard={!isUnpaired}>
        {/* (drawer) is a route group hosting the main app: Drawer with
            custom session-list sidebar, plus the new-session create page
            (index) and session detail. */}
        <Stack.Screen name="(drawer)" />
        {/* Settings rendered as iOS pageSheet — same physics as
            the tool-detail BottomSheet but as a routable modal
            (gets a URL, supports deep linking). */}
        <Stack.Screen
          name="settings"
          options={{ presentation: "pageSheet" }}
        />
        {/* Dev probe page — keep as a standard push, no modal. */}
        <Stack.Screen name="dev/diffs" />
      </Stack.Protected>
    </Stack>
  );
}

// Splash gate. Two concerns are intentionally separate:
//
//   - `isInitialized` — sticky flag, "have we reached any settled state
//     this launch?" Drives the splash branch. Native splash is one-shot;
//     once we hide it, we never re-show it on later reconnects.
//   - `isLoading` / `error` — the live status. Used for the first-attempt
//     error UI and to drive the Retry button's pending state.
//
// Pair-vs-main branching is NOT done here — that lives in `RootStack` via
// `Stack.Protected` guards on `isUnpaired`. We keep this gate minimal so
// the splash holds only on the "we don't know yet" window.
function DaemonGate({ children }: { children: React.ReactNode }) {
  const { isInitialized, isLoading, error, reset } = useDaemonClient();

  useEffect(() => {
    // Hide as soon as we have something user-meaningful to render — the
    // app, the pair screen, or the first-attempt error.
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
