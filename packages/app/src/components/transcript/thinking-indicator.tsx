import { useEffect } from "react";
import { useColorScheme, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

/**
 * Resident "Thinking…" indicator — the list's ListFooterComponent, always
 * mounted at a fixed height with `active` only fading the label. Kept mounted so
 * footerSize never changes: a footer counts toward anchoredEndSpace's
 * contentBelowAnchor, but a footerSize change doesn't trigger its recompute, so
 * toggling mount jumped the anchored message. Doubles as the gap below the last
 * message. `active` is on while the turn runs but Claude hasn't started its text;
 * a gentle opacity pulse, muted gray, reading as an assistant-side status line.
 */
export function ThinkingIndicator({ active }: { active: boolean }) {
  // Start hidden so the first mount of an idle session doesn't flash the label.
  const opacity = useSharedValue(0);
  const isDark = useColorScheme() === "dark";
  // gray-400 / gray-500 — applied inline (not className) so the color lands on
  // the reanimated Animated.Text regardless of the uniwind transform's reach.
  const color = isDark ? "#9ca3af" : "#6b7280";

  useEffect(() => {
    if (active) {
      // Seed the breathe floor, then bounce 0.4↔1.0 (withRepeat reverse uses the
      // value at animation start as the floor) — never fully invisible while live.
      opacity.value = 0.4;
      opacity.value = withRepeat(
        withTiming(1, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        -1, // infinite
        true, // reverse each cycle
      );
    } else {
      cancelAnimation(opacity);
      opacity.value = withTiming(0, { duration: 150 });
    }
  }, [active, opacity]);

  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <View className="px-4 py-1.5">
      <Animated.Text style={[style, { fontSize: 16, lineHeight: 22, color }]}>
        Thinking…
      </Animated.Text>
    </View>
  );
}
