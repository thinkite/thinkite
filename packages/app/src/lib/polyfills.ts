/**
 * Global Web Crypto polyfills for the RN/Hermes runtime.
 *
 * Import this FIRST in app/_layout.tsx (before anything else) so the
 * standards-based crypto globals exist before any consumer touches them —
 * `@noble/ed25519` identity key gen and, notably, TanStack DB, which ids
 * every optimistic mutation via the global `crypto.randomUUID()`
 * (createTransaction → Transaction#constructor).
 *
 * Why global rather than calling expo-crypto at each call site: the
 * `crypto.randomUUID()` calls live inside @tanstack/db itself (a call site
 * we don't control), and the library exposes no id-generator injector.
 * `crypto.getRandomValues` / `crypto.randomUUID` are Web Crypto platform
 * standards present in browsers / Node 19+ / Deno / Bun; Hermes is the
 * outlier, so we polyfill to match the contract libraries expect — exactly
 * what `react-native-get-random-values` does for `getRandomValues`.
 */
import "react-native-get-random-values"; // installs global.crypto.getRandomValues
import * as Crypto from "expo-crypto";

// react-native-get-random-values installs `getRandomValues` but NOT
// `randomUUID`. Back the missing half with expo-crypto's RFC4122 v4
// generator (guarded so we never clobber a real implementation).
const cryptoGlobal = globalThis as unknown as {
  crypto?: { randomUUID?: () => string };
};
if (
  cryptoGlobal.crypto !== undefined &&
  typeof cryptoGlobal.crypto.randomUUID !== "function"
) {
  cryptoGlobal.crypto.randomUUID = Crypto.randomUUID;
}
