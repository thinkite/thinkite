import { randomBytes } from "@noble/hashes/utils.js";
import { Stack, router } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  SignalingClient,
  type SignalingPeer,
  type SignalingState,
} from "@/lib/signaling-client";

/**
 * P3.2 spike: exercise the real `SignalingClient` class (not inline WS
 * code) and verify a) it connects to the production worker, b) emits
 * lifecycle states correctly, c) decodes the `peers` frame into typed
 * peer objects.
 *
 * Same fake-room trick as P3.1 — we use throwaway pubkeys so we just
 * watch the worker's initial roster (empty, since no daemon owns the
 * room). Production usage will pass real pubkeys from PairedDaemon.
 *
 * Delete (with the Stack.Screen entry in _layout.tsx) once DaemonClient
 * integration uses SignalingClient for real.
 */
type Result =
  | { status: "pending" }
  | {
      status: "ok";
      openedInMs: number;
      states: SignalingState[];
      peers: SignalingPeer[];
    }
  | { status: "error"; message: string };

export default function SignalingSpike() {
  const insets = useSafeAreaInsets();
  const [result, setResult] = useState<Result>({ status: "pending" });

  useEffect(() => {
    let canceled = false;
    void runSpike().then((r) => {
      if (!canceled) setResult(r);
    });
    return () => {
      canceled = true;
    };
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: "Signaling Spike" }} />
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 24,
        }}
        className="bg-white dark:bg-black"
      >
        <Text className="text-xl font-semibold text-black dark:text-white">
          SignalingClient → signaling.sidecode.app
        </Text>
        <Text className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          P3.2 — exercise the real SignalingClient module
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
              ? `✓ Connected in ${result.openedInMs}ms`
              : result.status === "error"
                ? "✗ Failed"
                : "Connecting…"}
          </Text>
          {result.status === "ok" && (
            <View className="mt-3 gap-2">
              <Text className="text-xs text-green-900 dark:text-green-200">
                lifecycle states (in order):
              </Text>
              {result.states.map((s, i) => (
                <Text
                  // biome-ignore lint/suspicious/noArrayIndexKey: spike
                  key={i}
                  selectable
                  className="font-mono text-xs text-green-900 dark:text-green-200"
                >
                  {`${i + 1}. ${s.kind}${
                    "attempt" in s ? ` (attempt=${s.attempt})` : ""
                  }`}
                </Text>
              ))}
              <Text className="mt-2 text-xs text-green-900 dark:text-green-200">
                peers from initial roster: {result.peers.length}
              </Text>
              {result.peers.map((p, i) => (
                <Text
                  // biome-ignore lint/suspicious/noArrayIndexKey: spike
                  key={i}
                  selectable
                  className="font-mono text-xs text-green-900 dark:text-green-200"
                >
                  {`${p.role} id=${p.id.slice(0, 10)} pubkey=${p.pubkey.slice(0, 10)}`}
                </Text>
              ))}
            </View>
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
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/")
          }
          className="mt-6 self-start rounded-md bg-gray-200 px-4 py-2 dark:bg-gray-800"
        >
          <Text className="text-sm text-black dark:text-white">Back</Text>
        </Pressable>
      </ScrollView>
    </>
  );
}

function encodeBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function runSpike(): Promise<Result> {
  const daemonPubkey = encodeBase64Url(randomBytes(32));
  const clientPubkey = encodeBase64Url(randomBytes(32));

  const states: SignalingState[] = [];
  const peers: SignalingPeer[] = [];
  let openedAt: number | null = null;
  const start = Date.now();

  return new Promise<Result>((resolve) => {
    const client = new SignalingClient({
      daemonPubkey,
      clientPubkey,
      onState: (s) => {
        states.push(s);
        if (s.kind === "open") openedAt = Date.now();
      },
      onPeers: (ps) => {
        peers.push(...ps);
      },
    });
    client.connect();

    // Give it 2.5s — enough for connect + initial peers frame + a settled
    // state read, but short enough that "stuck connecting" surfaces as
    // an error in the UI.
    setTimeout(() => {
      client.close();
      if (openedAt === null) {
        resolve({
          status: "error",
          message: `never reached open. states: ${states
            .map((s) => s.kind)
            .join(",")}`,
        });
      } else {
        resolve({
          status: "ok",
          openedInMs: openedAt - start,
          states,
          peers,
        });
      }
    }, 2500);
  });
}
