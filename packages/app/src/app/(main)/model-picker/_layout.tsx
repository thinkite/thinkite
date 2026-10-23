import { Stack } from "expo-router";

/**
 * Inner Stack for the model-picker formSheet (registered in
 * `(main)/_layout.tsx`), there for the native header: its title, the
 * search bar (`Stack.SearchBar` in the page) and the Close button.
 * `headerShown` stays static — react-native-screens remounts a modal
 * screen whose header visibility changes.
 */
export default function ModelPickerLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerTransparent: true,
        headerTitle: "Model",
      }}
    />
  );
}
