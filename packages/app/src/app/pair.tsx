import { Button, Column, Host, Text } from "@expo/ui";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { decodePairOffer, type PairOffer } from "@/lib/daemon-client";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * `/pair` — modal route, the **Universal Link landing** for
 * `https://sidecode.app/pair?o=<base64url(pair.offer)>`.
 *
 * Unlike `/onboarding` (the fullscreen card a freshly-installed user
 * sees on cold start), this route is presented as an iOS form sheet at
 * a half-screen detent so the underlying screen stays visible. Two
 * scenarios:
 *
 *   1. **Unpaired user taps a UL** — `Stack.Protected` shows
 *      `/onboarding` underneath; this modal expands over it asking
 *      the user to confirm the Mac that issued the QR.
 *   2. **Paired user adds another Mac (V0.5+)** — sheet appears over
 *      whichever drawer screen they were on.
 *
 * The confirmation step exists to defend against drive-by pair URLs
 * (a malicious link in iMessage / Mail / a web page). Decoding +
 * `serviceName` + first LAN IP + countdown give the user enough
 * surface to recognize a legitimate offer from one of their own Macs.
 *
 * UX nuance — explicit (in-app scanner / paste on /onboarding) and
 * implicit (UL) pair entries diverge here:
 *   - in-app scan / paste → no confirmation modal, the user just
 *     showed clear intent.
 *   - UL → this modal, always.
 *
 * All visuals use `@expo/ui` (SwiftUI / Jetpack Compose bridge) so the
 * sheet feels native on each platform without manual Liquid Glass
 * theming on our side.
 */
export default function PairModal() {
  const { o } = useLocalSearchParams<{ o?: string }>();
  const { pair } = useDaemonClient();

  const decoded = useMemo(() => decode(o), [o]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Countdown tick — only when a valid offer is mounted, so the
  // invalid / missing branches don't leak timers.
  useEffect(() => {
    if (decoded.status !== "ok") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [decoded.status]);

  // Cold-launch UL lands on /pair with an empty back stack — `router.back()`
  // fails with "The action 'GO_BACK' was not handled". canGoBack() lets us
  // detect that case and replace into the root, which Stack.Protected then
  // resolves to (drawer) when paired or onboarding when unpaired.
  const dismiss = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  };

  const handleCancel = () => {
    if (busy) return;
    dismiss();
  };

  const handleConfirm = async () => {
    if (decoded.status !== "ok" || busy) return;
    setBusy(true);
    setError(null);
    try {
      await pair(decoded.raw);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
      return;
    }
    // pair() flipped isUnpaired to false; Stack.Protected swaps the
    // background to (drawer). Dismissing the modal lets the user land
    // on the new anchor. Clear busy before navigate so a re-mount of
    // this route (e.g. user immediately scans another QR) doesn't
    // inherit a stuck "Pairing…" label.
    setBusy(false);
    dismiss();
  };

  if (decoded.status === "missing") {
    return (
      <ModalShell
        title="No pair code"
        body="To pair, scan a QR from sidecode on your Mac."
        onClose={handleCancel}
      />
    );
  }

  if (decoded.status === "invalid") {
    return (
      <ModalShell
        title="Invalid pair code"
        body="This QR isn't a valid sidecode pair code, or it's expired. Get a fresh one from your Mac."
        onClose={handleCancel}
      />
    );
  }

  const { offer } = decoded;
  const remainingMs = offer.expiresAt - now;
  const isExpired = remainingMs <= 0;
  const lanIp = firstLanIp(offer.daemonAddresses);
  const subtitle = isExpired
    ? "Pair code expired"
    : lanIp
      ? `${lanIp} · expires in ${formatCountdown(remainingMs)}`
      : `expires in ${formatCountdown(remainingMs)}`;

  return (
    <Host style={{ flex: 1 }}>
      {/* Block swipe-down while pair() is in flight so an accidental
          dismiss doesn't leave the daemon side mid-handshake. */}
      <Stack.Screen options={{ gestureEnabled: !busy }} />
      <Column
        spacing={24}
        alignment="center"
        style={{
          paddingHorizontal: 24,
          paddingTop: 32,
          paddingBottom: 16,
          width: "100%",
        }}
      >
        <Column spacing={12} alignment="center">
          <Text textStyle={{ fontSize: 20, fontWeight: "600" }}>
            Pair with this Mac?
          </Text>
          <Column spacing={4} alignment="center">
            <Text textStyle={{ fontSize: 22, fontWeight: "500" }}>
              {offer.serviceName}
            </Text>
            <Text textStyle={{ fontSize: 14, color: "#8E8E93" }}>
              {subtitle}
            </Text>
          </Column>
        </Column>

        <Column style={{ width: "100%" }} spacing={12}>
          {error && (
            <Text
              textStyle={{
                fontSize: 13,
                color: "#FF3B30",
                textAlign: "center",
              }}
            >
              {error}
            </Text>
          )}
          <Button
            variant="filled"
            label={busy ? "Pairing…" : "Pair this Mac"}
            style={{ width: "100%" }}
            onPress={handleConfirm}
            disabled={busy || isExpired}
          />
          <Button
            variant="outlined"
            label="Cancel"
            style={{ width: "100%" }}
            onPress={handleCancel}
            disabled={busy}
          />
        </Column>
      </Column>
    </Host>
  );
}

function ModalShell({
  title,
  body,
  onClose,
}: {
  title: string;
  body: string;
  onClose: () => void;
}) {
  return (
    <Host style={{ flex: 1 }}>
      <Column
        spacing={20}
        alignment="center"
        style={{
          paddingHorizontal: 24,
          paddingTop: 32,
          paddingBottom: 16,
          width: "100%",
        }}
      >
        <Column spacing={8} alignment="center">
          <Text textStyle={{ fontSize: 20, fontWeight: "600" }}>{title}</Text>
          <Text
            textStyle={{
              fontSize: 14,
              color: "#8E8E93",
              textAlign: "center",
            }}
          >
            {body}
          </Text>
        </Column>
        <Button
          variant="filled"
          label="Close"
          style={{ width: "100%" }}
          onPress={onClose}
        />
      </Column>
    </Host>
  );
}

type DecodeResult =
  | { status: "ok"; offer: PairOffer; raw: string }
  | { status: "missing" }
  | { status: "invalid"; error: Error };

function decode(o: string | undefined): DecodeResult {
  if (typeof o !== "string" || !o) return { status: "missing" };
  try {
    return { status: "ok", offer: decodePairOffer(o), raw: o };
  } catch (err) {
    return {
      status: "invalid",
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}

/**
 * Extract the first non-loopback host from the daemon's address list.
 * Order in the offer is LAN → Tailscale → loopback, so the first match
 * is the most identifiable for the user ("192.168.1.42" means "same
 * wifi as me", "100.x.x.x" means "Tailscale"). Loopback (`127.0.0.1`)
 * is omitted — only the simulator ever sees it as "their network."
 */
function firstLanIp(addresses: readonly string[]): string | null {
  for (const addr of addresses) {
    const match = addr.match(/^wss?:\/\/([^:/]+)/);
    if (!match) continue;
    const host = match[1];
    if (host === "127.0.0.1" || host === "localhost") continue;
    return host;
  }
  return null;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
