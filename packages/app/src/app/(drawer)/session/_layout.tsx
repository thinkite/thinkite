import { Stack } from "expo-router";

/**
 * Single-screen Stack wrapping the session detail. Exists purely so the
 * detail page gets a real UIKit `UINavigationBar` (rendered via
 * react-native-screens) instead of `@react-navigation/elements`'s JS-rendered
 * header — on iOS 26+ this is what gets the system Liquid Glass material.
 *
 * Header config + toolbar (hamburger button → openDrawer) live INSIDE the
 * page component (`[cliSessionId].tsx`), not here. Reason: `Stack.Toolbar`
 * with `onPress` callbacks needs a `useNavigation()` whose `.getParent()`
 * walks up to the Drawer. From inside the page that works (page's nav =
 * Stack, getParent = Drawer); from this layout file's render scope the
 * navigation context is ambiguous in expo-router 56's vendored navigators.
 */
export default function SessionStackLayout() {
  return (
    <Stack>
      <Stack.Screen name="[cliSessionId]" />
    </Stack>
  );
}
