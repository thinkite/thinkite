import { Stack, router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Temporary spike route to verify react-native-webrtc loads + instantiates
 * under Expo SDK 56 / RN 0.85 / New Architecture.
 *
 * Not pair-state-dependent — registered at root, reachable anytime.
 * Delete this file (+ Stack.Screen entry in _layout.tsx) once WebRTC
 * integration is real.
 */
type Result =
  | { status: "pending" }
  | { status: "ok"; details: Record<string, unknown> }
  | { status: "error"; message: string };

export default function WebrtcSpike() {
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<Result>({ status: "pending" });

  useEffect(() => {
    void runSpike().then(setResult);
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: "WebRTC Spike" }} />
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 24,
        }}
        className="bg-white dark:bg-black"
      >
        <Text className="text-xl font-semibold text-black dark:text-white">
          react-native-webrtc spike
        </Text>
        <Text className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Expo SDK 56 · RN 0.85 · New Arch · v124.0.7
        </Text>

        <View
          className={
            "mt-6 rounded-xl border p-4 " +
            (result.status === "ok"
              ? "border-green-400 bg-green-50 dark:border-green-700 dark:bg-green-950"
              : result.status === "error"
                ? "border-red-400 bg-red-50 dark:border-red-700 dark:bg-red-950"
                : "border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-900")
          }
        >
          <Text
            className={
              "text-base font-medium " +
              (result.status === "ok"
                ? "text-green-700 dark:text-green-300"
                : result.status === "error"
                  ? "text-red-700 dark:text-red-300"
                  : "text-gray-700 dark:text-gray-300")
            }
          >
            {result.status === "ok"
              ? "✓ WebRTC works"
              : result.status === "error"
                ? "✗ WebRTC failed"
                : "Running…"}
          </Text>
          {result.status === "ok" && (
            <Text
              selectable
              className="mt-2 font-mono text-xs text-green-900 dark:text-green-200"
            >
              {JSON.stringify(result.details, null, 2)}
            </Text>
          )}
          {result.status === "error" && (
            <Text
              selectable
              className="mt-2 font-mono text-xs text-red-900 dark:text-red-200"
            >
              {result.message}
            </Text>
          )}
        </View>

        <Pressable
          onPress={() => router.canGoBack() ? router.back() : router.replace("/")}
          className="mt-6 self-start rounded-md bg-gray-200 px-4 py-2 dark:bg-gray-800"
        >
          <Text className="text-sm text-black dark:text-white">Back</Text>
        </Pressable>
      </ScrollView>
    </>
  );
}

async function runSpike(): Promise<Result> {
  try {
    // Dynamic import so a broken bundle still renders the error UI instead
    // of crashing the route at module-load.
    const rtc = await import("react-native-webrtc");
    const RTCPeerConnection = rtc.RTCPeerConnection;
    if (typeof RTCPeerConnection !== "function") {
      return {
        status: "error",
        message: `RTCPeerConnection is ${typeof RTCPeerConnection}, expected function. Module exports: ${Object.keys(rtc).join(", ")}`,
      };
    }
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
    });
    // Force ICE gathering to start so we get more signal beyond "constructor works"
    const dc = pc.createDataChannel("spike", { ordered: true });
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);

    const details = {
      connectionState: pc.connectionState,
      iceConnectionState: pc.iceConnectionState,
      iceGatheringState: pc.iceGatheringState,
      signalingState: pc.signalingState,
      hasLocalDescription: pc.localDescription !== null,
      sdpHasFingerprint: pc.localDescription?.sdp.includes("fingerprint") ?? false,
      dataChannelReadyState: dc.readyState,
      moduleExports: Object.keys(rtc).slice(0, 12).join(", "),
    };
    pc.close();
    return { status: "ok", details };
  } catch (err) {
    return {
      status: "error",
      message: err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err),
    };
  }
}
