import * as ed25519 from "@noble/ed25519";
import { randomBytes } from "@noble/hashes/utils.js";
import { Stack, router } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  SignalingClient,
  type SignalingClientCallbacks,
  type SignalingState,
} from "@/lib/signaling-client";
import { WebRTCPeer, type WebRTCPeerState } from "@/lib/webrtc-peer";

/**
 * P3.4b spike: full iOS-side e2e against a real running daemon.
 *
 * Generates an ephemeral iOS keypair on mount and shows the pubkey for
 * you to paste into `run-paired-daemon.mjs` on your Mac. You then paste
 * the daemon's pubkey here, click Connect, and watch:
 *
 *   - SignalingClient connects to signaling worker
 *   - peer.joined fires for the daemon
 *   - daemon sends offer + fpSig → WebRTCPeer verifies, signs answer
 *   - ICE candidates flow both ways
 *   - DataChannel opens
 *   - ping/pong roundtrip
 *
 * Delete (with the Stack.Screen entry in _layout.tsx) once the real
 * DaemonClient is wired up.
 */

type Stage =
  | { kind: "idle" }
  | { kind: "connecting"; msg: string }
  | { kind: "handshaking"; sigState: SignalingState; peerState: WebRTCPeerState }
  | { kind: "ready"; rttMs: number }
  | { kind: "error"; msg: string };

// We use @noble/ed25519 v3's async API (signAsync / verifyAsync /
// getPublicKeyAsync) throughout — these rely on globalThis.crypto.subtle
// (present in RN's Hermes) and don't need the legacy `etc.sha512Sync`
// setter that's required for the sync codepath.

function encodeBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export default function P3HandshakeSpike() {
  const insets = useSafeAreaInsets();
  const [daemonPubkey, setDaemonPubkey] = useState("");
  const [stage, setStage] = useState<Stage>({ kind: "idle" });
  const [log, setLog] = useState<string[]>([]);
  const sigRef = useRef<SignalingClient | null>(null);
  const peerRef = useRef<WebRTCPeer | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);

  // Ephemeral keypair generated once per mount via async API. Real
  // DaemonClient will load from SecureStore.
  const [keypair, setKeypair] = useState<{
    privateKey: Uint8Array;
    publicKey: Uint8Array;
    pubkeyB64: string;
  } | null>(null);
  useEffect(() => {
    void (async () => {
      const privateKey = randomBytes(32);
      const publicKey = await ed25519.getPublicKeyAsync(privateKey);
      setKeypair({ privateKey, publicKey, pubkeyB64: encodeBase64Url(publicKey) });
    })();
    return () => {
      sigRef.current?.close();
      peerRef.current?.close();
    };
  }, []);

  const append = (line: string) =>
    setLog((l) => [...l, `[${new Date().toLocaleTimeString()}] ${line}`]);

  const connect = () => {
    if (!daemonPubkey.trim() || !keypair) return;
    setLog([]);
    setStage({ kind: "connecting", msg: "opening signaling…" });
    let daemonId: string | null = null;
    let sigState: SignalingState = { kind: "connecting", attempt: 0 };
    let peerState: WebRTCPeerState = "idle";
    const updateHandshake = () =>
      setStage({ kind: "handshaking", sigState, peerState });

    const peer = new WebRTCPeer({
      signFingerprint: async (transcript) => {
        const sig = await ed25519.signAsync(transcript, keypair.privateKey);
        return encodeBase64Url(sig);
      },
      verifyFingerprint: async (transcript, sigB64) => {
        try {
          return await ed25519.verifyAsync(
            decodeBase64Url(sigB64),
            transcript,
            decodeBase64Url(daemonPubkey.trim()),
          );
        } catch (err) {
          append(`verify error: ${(err as Error).message}`);
          return false;
        }
      },
      onLocalCandidate: (candidate) => {
        if (!daemonId) return;
        sigRef.current?.send(daemonId, "candidate", { candidate });
      },
      onDataChannelOpen: (dc) => {
        dcRef.current = dc;
        append("DataChannel open — sending ping");
        const pingT = Date.now();
        const dcAny = dc as unknown as {
          send: (s: string) => void;
          addEventListener: (e: string, cb: (e: unknown) => void) => void;
        };
        dcAny.addEventListener("message", (event) => {
          const data = (event as { data: unknown }).data;
          try {
            const msg = JSON.parse(String(data));
            if (msg.type === "pong") {
              const rtt = Date.now() - pingT;
              append(`pong received (rtt=${rtt}ms)`);
              setStage({ kind: "ready", rttMs: rtt });
            }
          } catch {
            // ignore
          }
        });
        dcAny.send(JSON.stringify({ type: "ping", t: pingT }));
      },
      onState: (s) => {
        peerState = s;
        append(`peer.state: ${s}`);
        updateHandshake();
      },
    });
    peerRef.current = peer;

    const callbacks: SignalingClientCallbacks = {
      onState: (s) => {
        sigState = s;
        append(`signaling.state: ${s.kind}`);
        updateHandshake();
      },
      onPeers: (peers) => {
        const d = peers.find((p) => p.role === "daemon");
        if (d) {
          daemonId = d.id;
          append(`daemon online at id=${d.id.slice(0, 10)}`);
        } else {
          append("no daemon in initial roster — start run-paired-daemon.mjs?");
        }
      },
      onPeerJoined: (peer) => {
        if (peer.role === "daemon") {
          daemonId = peer.id;
          append(`daemon joined id=${peer.id.slice(0, 10)}`);
        }
      },
      onOffer: (from, sdp, fpSig) => {
        daemonId = from;
        append("offer received, verifying fpSig…");
        void peer
          .handleOffer(sdp, fpSig)
          .then(({ answerSdp, fpSig: ourSig }) => {
            append("answer sent");
            sigRef.current?.send(from, "answer", {
              sdp: answerSdp,
              fpSig: ourSig,
            });
          })
          .catch((err) => {
            append(`handleOffer error: ${(err as Error).message}`);
            setStage({ kind: "error", msg: (err as Error).message });
          });
      },
      onCandidate: (_from, candidate) => {
        void peer.addRemoteCandidate(candidate as RTCIceCandidateInit);
      },
      onProtocolError: (reason) => {
        append(`signaling error: ${reason}`);
      },
    };

    const sig = new SignalingClient({
      daemonPubkey: daemonPubkey.trim(),
      clientPubkey: keypair?.pubkeyB64 ?? "",
      ...callbacks,
    });
    sigRef.current = sig;
    sig.connect();
  };

  const disconnect = () => {
    sigRef.current?.close();
    peerRef.current?.close();
    sigRef.current = null;
    peerRef.current = null;
    setStage({ kind: "idle" });
    append("disconnected");
  };

  return (
    <>
      <Stack.Screen options={{ title: "P3 Handshake Spike" }} />
      <ScrollView
        contentContainerStyle={{
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
          paddingHorizontal: 20,
        }}
        className="bg-white dark:bg-black"
      >
        <Text className="text-xl font-semibold text-black dark:text-white">
          iOS ↔ daemon e2e
        </Text>
        <Text className="mt-1 text-xs text-gray-500 dark:text-gray-400">
          P3.4b — SignalingClient + WebRTCPeer + SDP-fp pinning
        </Text>

        <Text className="mt-5 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
          Step 1 — copy iOS pubkey
        </Text>
        <Text
          selectable
          className="mt-1 rounded-md bg-gray-100 p-2 font-mono text-xs text-black dark:bg-gray-900 dark:text-white"
        >
          {keypair?.pubkeyB64 ?? "(generating…)"}
        </Text>
        <Text className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          Run on your Mac:{"\n"}
          <Text className="font-mono">
            node packages/daemon/scripts/run-paired-daemon.mjs &lt;paste-above&gt;
          </Text>
        </Text>

        <Text className="mt-5 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
          Step 2 — paste daemon pubkey (printed by the script)
        </Text>
        <TextInput
          value={daemonPubkey}
          onChangeText={setDaemonPubkey}
          placeholder="base64url"
          placeholderTextColor="#888"
          autoCapitalize="none"
          autoCorrect={false}
          className="mt-1 rounded-md bg-gray-100 p-2 font-mono text-xs text-black dark:bg-gray-900 dark:text-white"
        />

        <View className="mt-4 flex-row gap-2">
          <Pressable
            onPress={connect}
            disabled={!daemonPubkey.trim() || stage.kind !== "idle"}
            className="flex-1 rounded-md bg-blue-600 px-4 py-3 disabled:opacity-50"
          >
            <Text className="text-center font-semibold text-white">
              Connect
            </Text>
          </Pressable>
          <Pressable
            onPress={disconnect}
            disabled={stage.kind === "idle"}
            className="flex-1 rounded-md bg-gray-300 px-4 py-3 disabled:opacity-50 dark:bg-gray-700"
          >
            <Text className="text-center font-semibold text-black dark:text-white">
              Disconnect
            </Text>
          </Pressable>
        </View>

        <View
          className={
            "mt-5 rounded-xl border p-3 " +
            (stage.kind === "ready"
              ? "border-green-400 bg-green-50 dark:border-green-700 dark:bg-green-950"
              : stage.kind === "error"
                ? "border-red-400 bg-red-50 dark:border-red-700 dark:bg-red-950"
                : "border-gray-300 bg-gray-50 dark:border-gray-700 dark:bg-gray-900")
          }
        >
          <Text className="text-sm font-medium text-black dark:text-white">
            {stage.kind === "idle" && "idle"}
            {stage.kind === "connecting" && stage.msg}
            {stage.kind === "handshaking" &&
              `handshake: signaling=${stage.sigState.kind} peer=${stage.peerState}`}
            {stage.kind === "ready" &&
              `✓ DataChannel open — ping/pong rtt=${stage.rttMs}ms`}
            {stage.kind === "error" && `✗ ${stage.msg}`}
          </Text>
        </View>

        <Text className="mt-4 text-xs font-medium uppercase text-gray-500 dark:text-gray-400">
          log
        </Text>
        <View className="mt-1 rounded-md bg-gray-100 p-2 dark:bg-gray-900">
          {log.length === 0 ? (
            <Text className="font-mono text-xs text-gray-400">(empty)</Text>
          ) : (
            log.map((line, i) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: spike
                key={i}
                selectable
                className="font-mono text-xs text-black dark:text-white"
              >
                {line}
              </Text>
            ))
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
