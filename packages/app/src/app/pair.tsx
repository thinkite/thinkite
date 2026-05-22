import { Button, Column, Host, Icon, Spacer, Text } from "@expo/ui";
import { controlSize, frame } from "@expo/ui/swift-ui/modifiers";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
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
 * The confirmation step defends against drive-by pair URLs (a
 * malicious link in iMessage / Mail / a web page). Decoded
 * `serviceName` + first LAN IP + countdown give the user enough
 * surface to recognize a legitimate offer from one of their own Macs.
 *
 * UX nuance — explicit (in-app scanner / paste on /onboarding) and
 * implicit (UL) pair entries diverge here:
 *   - in-app scan / paste → no confirmation modal, the user just
 *     showed clear intent.
 *   - UL → this modal, always.
 *
 * Visual language mirrors the iOS system sign-in / passkey sheet:
 *   - Native iOS sheet header with X close button (top-right)
 *   - Computer SF Symbol, title and body text top-leading
 *   - Two full-width stacked buttons pinned to the bottom (primary
 *     filled + secondary outlined)
 *
 * Implementation:
 * - Universal `@expo/ui` components (variant="filled"/"outlined" map
 *   to SwiftUI .borderedProminent/.bordered on iOS; same shape will
 *   render via Compose on Android once we add modifiers).
 * - SwiftUI escape hatch only where Universal can't reach: button
 *   `controlSize("large")` and the `.frame(maxWidth: .infinity)` on
 *   the label Text that triggers the "Button hugs label, so widen
 *   label" SwiftUI idiom for full-width sheet CTAs.
 * - When Android lands (V0.5+), mirror the modifier paths via
 *   `@expo/ui/jetpack-compose/modifiers` in a `pair.android.tsx`.
 *
 * Layout structure: single Host + Stack.Toolbar wrapping the route,
 * with the three decode states (ok / missing / invalid) branching
 * only on text + button contents inside the same outer Column. Keeps
 * chrome (header, padding, button layout) defined once.
 */
export default function PairModal() {
  const { o } = useLocalSearchParams<{ o?: string }>();
  const { pair } = useDaemonClient();

  const decoded = useMemo(() => decode(o), [o]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Per-state copy + actions. Chrome (Host, Toolbar, Column, padding)
  // is shared across states, so we only vary the title / body / buttons.
  let title: string;
  let body: string;
  let primaryAction: { label: string; onPress: () => void; disabled: boolean };
  let secondary: { label: string; onPress: () => void } | null = null;

  if (decoded.status === "missing") {
    title = "No pair code";
    body = "To pair, scan a QR from sidecode on your Mac.";
    primaryAction = { label: "Close", onPress: handleCancel, disabled: false };
  } else if (decoded.status === "invalid") {
    title = "Invalid pair code";
    body =
      "This QR isn't a valid sidecode pair code, or it's expired. Get a fresh one from your Mac.";
    primaryAction = { label: "Close", onPress: handleCancel, disabled: false };
  } else {
    title = "Pair with this Mac?";
    // No countdown: the daemon's pair-window-open gate (not the QR) is
    // the authority on whether this pair can succeed right now. If it
    // can't, we surface that via the connect-timeout error message.
    body = "Make sure the Pair window is open on your Mac.";
    primaryAction = {
      label: busy ? "Pairing…" : "Pair this Mac",
      onPress: handleConfirm,
      disabled: busy,
    };
    secondary = { label: "Cancel", onPress: handleCancel };
  }

  const serviceName =
    decoded.status === "ok" ? decoded.offer.serviceName : null;

  return (
    <Host style={{ flex: 1 }}>
      {/* Block swipe-down while pair() is in flight so an accidental
          dismiss doesn't leave the daemon side mid-handshake. */}
      <Stack.Screen options={{ gestureEnabled: !busy }} />
      {/* Header X (top-right). `headerShown: true` is set statically in
          the parent _layout.tsx — toggling it from here would remount
          the modal screen (react-native-screens warning). */}
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="xmark"
          onPress={handleCancel}
          accessibilityLabel="Close"
        />
      </Stack.Toolbar>
      <Column
        alignment="start"
        modifiers={[frame({ maxWidth: Infinity, alignment: "topLeading" })]}
        style={{ paddingHorizontal: 20 }}
      >
        <Column alignment="start" spacing={12}>
          <Icon name="laptopcomputer.and.iphone" size={56} color="#007AFF" />
          <Column alignment="start" spacing={6}>
            <Text textStyle={{ fontSize: 22, fontWeight: "600" }}>{title}</Text>
            {serviceName && (
              <Text textStyle={{ fontSize: 17 }}>{serviceName}</Text>
            )}
            <Text textStyle={{ fontSize: 15, color: "#8E8E93" }}>{body}</Text>
          </Column>
          {error && (
            <Text textStyle={{ fontSize: 13, color: "#FF3B30" }}>{error}</Text>
          )}
        </Column>

        <Spacer flexible />

        <Column
          alignment="start"
          spacing={8}
          modifiers={[frame({ maxWidth: Infinity, alignment: "topLeading" })]}
        >
          <Button
            variant="filled"
            onPress={primaryAction.onPress}
            disabled={primaryAction.disabled}
            modifiers={[controlSize("large")]}
          >
            <Text
              textStyle={{
                fontSize: 17,
                fontWeight: "600",
                textAlign: "center",
              }}
              modifiers={[frame({ maxWidth: Infinity })]}
            >
              {primaryAction.label}
            </Text>
          </Button>
          {secondary && (
            <Button
              variant="outlined"
              onPress={secondary.onPress}
              disabled={busy}
              modifiers={[controlSize("large")]}
            >
              <Text
                textStyle={{ fontSize: 17, textAlign: "center" }}
                modifiers={[frame({ maxWidth: Infinity })]}
              >
                {secondary.label}
              </Text>
            </Button>
          )}
        </Column>
      </Column>
    </Host>
  );
}

type DecodeResult =
  | { status: "ok"; offer: PairOffer; raw: string }
  | { status: "missing" }
  | { status: "invalid" };

function decode(o: string | undefined): DecodeResult {
  if (typeof o !== "string" || !o) return { status: "missing" };
  try {
    return { status: "ok", offer: decodePairOffer(o), raw: o };
  } catch {
    return { status: "invalid" };
  }
}
