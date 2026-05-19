import { Stack } from "expo-router";
import { useColorScheme } from "react-native";

/**
 * Nested Stack inside the root-level pageSheet modal. The root layout
 * registers `name="settings"` with `presentation: "pageSheet"`; this Stack
 * lives inside that sheet container and pushes its own screens within it,
 * so list → host detail is an in-sheet push (with native back arrow) and
 * not a stacked second sheet.
 *
 * Native header is on by default; per-screen options (title / headerLeft /
 * headerRight) live on the leaf files.
 */
export default function SettingsLayout() {
  const scheme = useColorScheme() ?? "light";
  const headerTint = scheme === "dark" ? "#ffffff" : "#000000";
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerTintColor: headerTint,
        headerTransparent: true,
        headerBackButtonDisplayMode: "minimal",
      }}
    />
  );
}
