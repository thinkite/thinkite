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

// expo-router modal anchor: when a deep link / Universal Link lands
// directly on the `/pair` modal (cold-launch from a tapped QR link),
// the router needs a background route to materialize underneath the
// modal — otherwise the iOS formSheet has nothing to attach to and
// silently degrades into a fullscreen card.
//
// The anchor MUST point to a route that's currently accessible. With
// Stack.Protected previously at the root, anchoring to either
// `onboarding` or `(drawer)` broke the opposite state. Hoisting the
// gating one level down into `app/(main)/_layout.tsx` lets us anchor
// to the group itself — `(main)` is always reachable, and its inner
// stack handles the unpaired/paired routing.
export const unstable_settings = {
  anchor: "(main)",
};

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
 * Root Stack — just two siblings:
 *
 *   - `pair` — UL landing modal (formSheet, half-detent). Always
 *     accessible because cold-launch UL has no history to fall back
 *     on; this slot has to be unguarded.
 *   - `(main)` — group hosting the real app surface. Its own
 *     `_layout.tsx` runs the Stack.Protected gating between
 *     `onboarding` (unpaired) and `(drawer) / settings / dev/diffs`
 *     (paired).
 *
 * Anchor (declared above) points at `(main)` so the formSheet has a
 * stable background regardless of paired state. URL paths are
 * unaffected: route groups are URL-transparent.
 *
 * DaemonGate (below) still gates the entire Stack on `isInitialized`
 * to keep the native splash up until the daemon-client state settles.
 */
function RootStack() {
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(main)" />
      <Stack.Screen
        name="pair"
        options={{
          presentation: "formSheet",
          // [0.5] = half-screen detent. The named `"medium"` literal is
          // only available on the lower-level react-native-screens type;
          // expo-router's wrapper accepts `number[] | "fitToContents"`.
          sheetAllowedDetents: [0.5],
          sheetGrabberVisible: true,
          title: "",
        }}
      />
      {/* Temporary spike route — verifies react-native-webrtc loads under
          New Arch. Reachable independently of pair state. Delete once
          WebRTC integration is real. */}
      <Stack.Screen name="webrtc-spike" />
      {/* P3.1 spike — partysocket → signaling worker round-trip from RN.
          Delete with the SignalingClient integration. */}
      <Stack.Screen name="signaling-spike" />
      {/* P3.4b spike — full iOS↔daemon e2e handshake via SignalingClient
          + WebRTCPeer + SDP-fp pinning. Requires Mac running
          packages/daemon/scripts/run-paired-daemon.mjs. */}
      <Stack.Screen name="p3-handshake-spike" />
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
// Pair-vs-main branching is NOT done here — that lives inside `(main)/_layout`
// via `Stack.Protected` guards on `isUnpaired`. We keep this gate minimal so
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
