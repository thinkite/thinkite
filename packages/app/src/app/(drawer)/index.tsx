import * as Crypto from "expo-crypto";
import { router, Stack, useNavigation } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InputBar } from "@/components/transcript/input-bar";
import { useDaemonClient } from "@/lib/daemon-client-context";
import { DEV_CWD } from "@/lib/dev-config";
import { DrawerActions } from "expo-router/react-navigation";

/**
 * (drawer)/index — new-session create page. Replaces the original H1 list
 * route (which moved into the drawer's drawerContent) AND the originally
 * planned H3 /sessions/new form. Acts as the app's default empty state on
 * cold launch when no session is selected.
 *
 * Flow on first send:
 *   1. Generate a fresh UUIDv4 client-side
 *   2. `client.sendPrompt(newId, text, DEV_CWD)` — daemon's create-or-resume
 *      router-side decision sees no existing session → creates a new one
 *   3. `router.replace("/session/[id]")` — replace, not push, so back button
 *      doesn't return to a stale empty index
 *
 * cwd is hardcoded via DEV_CWD for V0; cwd picker is a V0.5+ task. See
 * lib/dev-config.ts for the constant.
 */
export default function NewSessionScreen() {
  const { client } = useDaemonClient();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  const handleSend = useCallback(
    (text: string) => {
      if (!client) return;
      const newId = Crypto.randomUUID();
      void client
        .sendPrompt(newId, text, DEV_CWD)
        .then(() => {
          router.replace({
            pathname: "/session/[cliSessionId]",
            params: { cliSessionId: newId, cwd: DEV_CWD },
          });
        })
        .catch((err) => {
          console.error("sendPrompt (new session) failed", err);
        });
    },
    [client],
  );

  const openDrawer = useCallback(() => {
    // Drawer's openDrawer/closeDrawer aren't on the typed nav prop here;
    // dispatch via the drawer-specific action.
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <View
        className="flex-1 bg-white dark:bg-black"
        style={{ paddingTop: insets.top }}
      >
        {/* Header — hamburger to open drawer (iOS users may also swipe from edge). */}
        <View className="flex-row items-center px-4 py-2">
          <Pressable
            onPress={openDrawer}
            hitSlop={8}
            className="h-9 w-9 items-center justify-center rounded-full bg-gray-100 dark:bg-gray-800"
          >
            <SymbolView name="line.3.horizontal" size={18} />
          </Pressable>
        </View>

        {/* Empty state */}
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-2xl font-semibold text-black dark:text-white">
            New session
          </Text>
          <Text
            selectable
            className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400"
            numberOfLines={1}
          >
            cwd: {DEV_CWD}
          </Text>
        </View>

        {/* InputBar — same component used inside session detail. The
            pinned-to-bottom keyboard handling matches the detail screen. */}
        <KeyboardStickyView
          offset={{ closed: -insets.bottom, opened: -12 }}
          style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
        >
          <InputBar onSend={handleSend} isRunning={false} />
        </KeyboardStickyView>
      </View>
    </>
  );
}
