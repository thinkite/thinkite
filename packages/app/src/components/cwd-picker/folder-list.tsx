import { Text, View } from "react-native";

/**
 * Android / web stub for the cwd picker folder list. V0 is iOS-only per
 * [project_v0_distribution]; this exists solely so Metro can resolve
 * `./folder-list` on non-iOS platforms (the real impl lives in
 * `folder-list.ios.tsx`, which Metro auto-selects on iOS via the
 * platform-suffix resolver).
 *
 * When sidecode adds Android support, replace this with a Material 3
 * equivalent using `@expo/ui/jetpack-compose` (ListItem inside Box, etc.).
 */
export function FolderList(_: { path: string | undefined }) {
  return (
    <View className="flex-1 items-center justify-center bg-white px-6 dark:bg-black">
      <Text className="text-center text-sm text-gray-500 dark:text-gray-400">
        Folder picker is iOS-only in V0.
      </Text>
    </View>
  );
}
