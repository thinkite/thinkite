import { CameraView, useCameraPermissions } from "expo-camera";
import { router, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * `/onboarding` — first-launch / re-pair gate (only reachable while
 * `isUnpaired` is true). Two entry methods:
 *
 *   1. **Scan QR** — `CameraView.launchScanner` opens the iOS 16+
 *      `DataScannerViewController` modal. We register the result via
 *      `CameraView.onModernBarcodeScanned` BEFORE calling launchScanner;
 *      iOS auto-dismisses the scanner on Android, but on iOS we call
 *      `dismissScanner()` explicitly so the modal goes away as soon as
 *      we have a value. Permission is requested lazily on the first tap.
 *
 *   2. **Paste payload** — TextInput accepting the base64url string
 *      that `sidecode pair` prints next to the QR. This is the simulator
 *      path (no real camera) and the fallback if the user can't get
 *      VisionKit to focus.
 *
 * Both paths route the extracted payload to the `/pair` modal via
 * `router.push("/pair?o=...")` — the modal is the single owner of the
 * `pair()` call (busy state, error surface, "Pair with this Mac?"
 * confirmation). UL deep-links land on the same modal, so all entry
 * paths converge on one piece of code.
 *
 * UX note: scan and paste are visible side-by-side; we don't gate the
 * scan button on `Device.isDevice` because (a) the simulator behavior
 * of `launchScanner` is to reject (caught below and surfaced as a
 * hint) rather than crash, and (b) hiding native UI when a paste path
 * is present would just confuse anyone running on a simulator. The
 * bias is "if it doesn't work, the paste field is right below it."
 */
/**
 * The menu bar app encodes the pair offer as a Universal Link URL
 * (`https://sidecode.app/pair?o=<base64url>`) so the iPhone's built-in
 * Camera app can scan it and open straight into the app. The in-app
 * scanner / paste field accepts either form — bare base64url (legacy
 * `sidecode pair` CLI output) or the full URL.
 */
function extractOfferPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  // Tolerate any URL whose `o` query param holds the offer — keeps the
  // scanner working if we ever change the canonical host (preview /
  // staging) without re-rolling the iOS app.
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const o = url.searchParams.get("o");
      if (o) return o;
    } catch {
      // Fall through — treat malformed URL as bare payload.
    }
  }
  return trimmed;
}

export default function OnboardingRoute() {
  const insets = useSafeAreaInsets();
  const scheme = useColorScheme() ?? "light";
  // Tuple shape from useCameraPermissions: [status, request, get]. We only
  // need the request action — there's no UI dependency on `status`, the
  // user always taps "Scan QR" first which fires the request.
  const [, requestCameraPermission] = useCameraPermissions();

  const [pasteValue, setPasteValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Guards against a stale onModernBarcodeScanned callback firing after
  // we've already kicked off the pair modal (the scanner can deliver
  // multiple results in quick succession before dismiss completes).
  const handlingScanRef = useRef(false);

  const openPairModal = useCallback((raw: string) => {
    const payload = extractOfferPayload(raw);
    if (!payload) {
      setError("Empty payload");
      return;
    }
    setError(null);
    // The modal owns busy/error/confirmation UI from here on.
    router.push({ pathname: "/pair", params: { o: payload } });
  }, []);

  const handleScan = useCallback(async () => {
    setError(null);
    try {
      const perm = await requestCameraPermission();
      if (!perm.granted) {
        setError("Camera permission denied. Use 'Paste payload' below.");
        return;
      }
      handlingScanRef.current = false;
      const sub = CameraView.onModernBarcodeScanned((event) => {
        if (handlingScanRef.current) return;
        handlingScanRef.current = true;
        sub.remove();
        void CameraView.dismissScanner();
        openPairModal(event.data);
      });
      try {
        await CameraView.launchScanner({ barcodeTypes: ["qr"] });
      } catch (err) {
        sub.remove();
        // launchScanner rejects on simulator (no DataScannerViewController
        // hardware path) — surface a clear hint pointing at the paste
        // field instead of dropping the user into a generic error.
        setError(
          `Scanner unavailable on this device. Paste the payload from \`sidecode pair\` below. (${
            err instanceof Error ? err.message : String(err)
          })`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [requestCameraPermission, openPairModal]);

  const handlePaste = useCallback(() => {
    openPairModal(pasteValue);
  }, [pasteValue, openPairModal]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            flexGrow: 1,
            paddingTop: insets.top + 24,
            paddingBottom: insets.bottom + 24,
            paddingHorizontal: 24,
          }}
          className="bg-white dark:bg-black"
        >
          {/* Brand + intro */}
          <View className="mb-8">
            <Text className="text-3xl font-semibold text-black dark:text-white">
              sidecode
            </Text>
            <Text className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-gray-400">
              Connect this phone to your Mac's sidecode daemon. On your Mac, run{" "}
              <Text className="font-mono text-gray-900 dark:text-gray-200">
                sidecode pair
              </Text>{" "}
              and either scan the QR code or paste the payload below.
            </Text>
          </View>

          {/* Scan CTA */}
          <Pressable
            onPress={handleScan}
            className="mb-3 flex-row items-center justify-center gap-3 rounded-2xl bg-black px-5 py-4 dark:bg-white"
          >
            <SymbolView
              name="qrcode.viewfinder"
              size={22}
              tintColor={scheme === "dark" ? "#0a0a0a" : "#ffffff"}
            />
            <Text className="text-base font-semibold text-white dark:text-black">
              Scan QR code
            </Text>
          </Pressable>

          {/* Divider */}
          <View className="my-5 flex-row items-center">
            <View className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
            <Text className="mx-3 text-xs uppercase tracking-wider text-gray-500 dark:text-gray-500">
              or
            </Text>
            <View className="h-px flex-1 bg-gray-200 dark:bg-gray-800" />
          </View>

          {/* Paste field */}
          <Text className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            Paste payload
          </Text>
          <TextInput
            value={pasteValue}
            onChangeText={setPasteValue}
            placeholder="paste pair code from sidecode pair"
            placeholderTextColor={scheme === "dark" ? "#52525b" : "#a1a1aa"}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            multiline
            className="min-h-24 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 font-mono text-xs text-black dark:border-gray-800 dark:bg-gray-950 dark:text-white"
          />
          <Pressable
            onPress={handlePaste}
            disabled={!pasteValue.trim()}
            className="mt-3 flex-row items-center justify-center gap-2 rounded-2xl border border-gray-300 bg-white px-5 py-4 dark:border-gray-700 dark:bg-gray-950"
            style={!pasteValue.trim() ? { opacity: 0.5 } : undefined}
          >
            <Text className="text-base font-medium text-black dark:text-white">
              Connect
            </Text>
          </Pressable>

          {/* Error / status */}
          {error && (
            <View className="mt-4 rounded-xl border border-red-300 bg-red-50 px-4 py-3 dark:border-red-800 dark:bg-red-950">
              <Text
                selectable
                className="text-xs text-red-700 dark:text-red-300"
              >
                {error}
              </Text>
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </>
  );
}
