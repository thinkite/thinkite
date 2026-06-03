import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { ScrollView, Text, useColorScheme, View } from "react-native";

/**
 * Dev spike: pick the tint for the session-list "running" indicator. We've
 * settled on `ellipsis` + variableColor (a "…" shimmer that reads as
 * "thinking / generating"); this page renders it in candidate colors as faux
 * rows — same 16pt leading slot + title layout as the real `SessionRow` — so
 * the color is judged in context, with the idle dot on top for reference.
 *
 * Chosen: secondary gray (`#8E8E93`) — see `RUNNING_COLOR` in `session-row.tsx`.
 * Kept around as a living reference for revisiting the tint/style.
 */

// Same effect the real row uses: variableColor sweeps the ellipsis's three
// layers in sequence (native expo-symbols effect, no reanimated).
const RUNNING_SPEC = {
  variableAnimationSpec: { iterative: true, reversing: true },
  repeating: true,
};

const COLORS: { name: string; light: string; dark: string }[] = [
  { name: "secondary gray", light: "#8E8E93", dark: "#8E8E93" },
  { name: "accent blue", light: "#007AFF", dark: "#0A84FF" },
  { name: "green", light: "#34C759", dark: "#30D158" },
  { name: "teal", light: "#30B0C7", dark: "#64D2FF" },
  { name: "indigo", light: "#5856D6", dark: "#5E5CE6" },
  { name: "orange", light: "#FF9500", dark: "#FF9F0A" },
  { name: "primary (label)", light: "#000000", dark: "#FFFFFF" },
];

function FauxRow({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: React.ReactNode;
}) {
  return (
    <View className="flex-row items-center gap-2.5 border-b border-gray-100 px-4 py-2.5 dark:border-gray-900">
      <View className="w-5 items-center justify-center">{children}</View>
      <Text
        numberOfLines={1}
        className="flex-1 text-base text-black dark:text-white"
      >
        {title}
      </Text>
      <Text className="text-xs text-gray-400 dark:text-gray-500">
        {caption}
      </Text>
    </View>
  );
}

export default function RunningIndicatorsScreen() {
  const dark = (useColorScheme() ?? "light") === "dark";

  return (
    <>
      <Stack.Screen options={{ title: "Running color" }} />
      <ScrollView
        className="flex-1 bg-white dark:bg-black"
        contentContainerStyle={{ paddingBottom: 48 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <Text className="px-4 pt-4 pb-2 text-sm text-gray-500 dark:text-gray-400">
          ellipsis + variableColor in candidate tints — same slot as the real
          row. Idle dot on top for reference.
        </Text>

        <FauxRow title="Idle session" caption="idle">
          <View className="h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600" />
        </FauxRow>

        {COLORS.map((c) => (
          <FauxRow key={c.name} title="Working session…" caption={c.name}>
            <SymbolView
              name="ellipsis"
              size={16}
              tintColor={dark ? c.dark : c.light}
              animationSpec={RUNNING_SPEC}
            />
          </FauxRow>
        ))}
      </ScrollView>
    </>
  );
}
