import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import type { ReactNode } from "react";
import { useState } from "react";
import { Pressable, Text, TextInput, useColorScheme, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Shared chrome for the two `dev/menu-*` test routes. Strips the real
 * InputBar down to the minimum needed to reproduce the iOS-IME keyboard
 * menu alignment bug:
 *
 *   - centered TextInput (focus to open keyboard)
 *   - KeyboardStickyView pinning a fake composer pill at the bottom
 *   - the pill has `[ menuButton ] ... [ mic icon ]` so the test menu
 *     trigger and a sibling RN Pressable line up in the same flex row
 *
 * The two routes (dev/menu-expo, dev/menu-rnm) pass identical mic +
 * surrounding markup; only `menuButton` differs. If `+` lands at a
 * different y than mic on first system-IME keyboard show, the menu
 * library is the variable.
 */
export function MenuTestScreen({
  title,
  menuButton,
}: {
  title: string;
  menuButton: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme() ?? "light";
  const [text, setText] = useState("");

  return (
    <>
      <Stack.Screen options={{ title }} />
      <View className="flex-1 bg-white dark:bg-black">
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-base text-zinc-600 dark:text-zinc-300">
            Tap the input to open the keyboard, then tap the + button.
            {"\n"}
            Verify + aligns with the mic icon on the right.
          </Text>
        </View>

        <KeyboardStickyView
          offset={{ closed: -insets.bottom, opened: -8 }}
          style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
        >
          <View className="px-4 pb-2">
            <View
              style={{
                borderRadius: 24,
                paddingVertical: 8,
                backgroundColor:
                  colorScheme === "dark"
                    ? "rgba(28,28,30,0.6)"
                    : "rgba(255,255,255,0.6)",
              }}
            >
              <TextInput
                multiline
                value={text}
                onChangeText={setText}
                placeholder="Type here to open keyboard"
                placeholderTextColor={
                  colorScheme === "dark" ? "#71717a" : "#a1a1aa"
                }
                style={{
                  color: colorScheme === "dark" ? "#fafafa" : "#0a0a0a",
                  backgroundColor:
                    colorScheme === "dark" ? "#1c1c1e" : "#ffffff",
                  borderWidth: 1,
                  borderColor: colorScheme === "dark" ? "#3f3f46" : "#d4d4d8",
                  borderRadius: 12,
                  marginHorizontal: 8,
                }}
                className="text-base px-3 py-2"
              />
              <View className="px-3 flex-row items-center justify-between">
                {menuButton}
                <Pressable className="p-1.75">
                  <SymbolView
                    name="mic"
                    size={22}
                    weight="regular"
                    tintColor={colorScheme === "dark" ? "#e4e4e7" : "#3f3f46"}
                  />
                </Pressable>
              </View>
            </View>
          </View>
        </KeyboardStickyView>
      </View>
    </>
  );
}
