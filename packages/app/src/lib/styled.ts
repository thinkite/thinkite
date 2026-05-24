/**
 * uniwind-instrumented third-party components.
 *
 * Built-in RN components (View, Text, ScrollView, etc.) and Reanimated work
 * with `className` out of the box. Third-party components that don't expose
 * `className` natively need to be wrapped via `withUniwind` once — otherwise
 * `className="flex-1 ..."` silently no-ops and the component collapses.
 *
 * Define wraps at module scope so they're stable across renders.
 *
 * Refs: https://docs.uniwind.dev/api/with-uniwind
 */
import { Image as ExpoImage } from "expo-image";
import { LinearGradient as ExpoLinearGradient } from "expo-linear-gradient";
import { SafeAreaView as RNSafeAreaView } from "react-native-safe-area-context";
import { withUniwind } from "uniwind";

export const SafeAreaView = withUniwind(RNSafeAreaView);
export const LinearGradient = withUniwind(ExpoLinearGradient);
export const Image = withUniwind(ExpoImage);
