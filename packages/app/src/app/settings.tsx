import { router, Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Pressable, Text, View } from "react-native";

/**
 * Settings — pageSheet modal at the root Stack level. Hosted ABOVE the
 * (drawer) group, so opens as an iOS native sheet (UISheetPresentationController)
 * sliding up over the drawer + main content. Same physics as the tool-detail
 * BottomSheet, but as a routable modal (gets `/settings` URL + deep linking
 * support).
 *
 * V0 placeholder. Sections will land incrementally:
 *   - Pair info (daemon fingerprint / address / re-pair button)
 *   - Default cwd picker (replaces DEV_CWD constant)
 *   - Theme preference (auto / light / dark)
 *   - About (version / build)
 */
export default function SettingsScreen() {
  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View className="flex-1 bg-white dark:bg-black">
        {/* Custom header — circular X button mirrors Claude iOS visual. The
            iOS pageSheet drag handle handles swipe-down dismissal natively;
            X is the explicit-tap escape hatch. */}
        <View className="flex-row items-center justify-between px-4 py-3">
          <Pressable
            onPress={() => router.back()}
            hitSlop={8}
            className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800"
          >
            <SymbolView name="xmark" size={14} />
          </Pressable>
          <Text className="text-base font-semibold text-black dark:text-white">
            Settings
          </Text>
          <View className="h-9 w-9" />
          {/* spacer to balance the X button so the title stays centered */}
        </View>

        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-sm text-gray-500 dark:text-gray-400">
            Settings coming soon.
          </Text>
        </View>
      </View>
    </>
  );
}
