import type { ImageAttachment } from "@sidecodeapp/protocol";
import * as Crypto from "expo-crypto";
import { router, Stack, useNavigation } from "expo-router";
import { DrawerActions } from "expo-router/react-navigation";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InputBar } from "@/components/transcript/input-bar";
import { DEV_CWD } from "@/lib/dev-config";
import { setPendingPrompt } from "@/lib/submission-store";

/**
 * (drawer)/(stack)/index — new-session create page, URL `/`. Lives inside
 * the same Stack as the detail screen so it inherits the native UIKit
 * UINavigationBar (iOS 26 Liquid Glass) via Stack.Header / Stack.Toolbar.
 *
 * Sibling-of-detail layout means the "+ New" sidebar action and "tap a
 * session row" action both translate to `router.replace` within the same
 * Stack — no drawer-screen swap, no inner-Stack remount, no flicker. The
 * `(stack)` group is invisible in URLs, so this page is just `/`, not
 * `/session` — cold launch lands here directly.
 *
 * Flow on first send:
 *   1. Generate a fresh UUIDv4 client-side
 *   2. Stash the prompt text in `submission-store` keyed by that UUID
 *   3. `router.replace("/session/[id]")` immediately — the user sees the
 *      detail screen with no perceptible RTT lag
 *   4. Detail screen mounts → `useLiveSession` fires `subscribe` and
 *      awaits its response (so daemon has registered the live fanout
 *      callback). Only then does it consume the pending prompt and fire
 *      `sendPrompt` — guaranteeing user_message + turn_started events
 *      reach the iOS subscriber instead of falling into the cursor
 *      race window. See lib/submission-store.ts for the full rationale.
 *
 * cwd is hardcoded via DEV_CWD for V0; cwd picker is a V0.5+ task.
 */
export default function NewSessionScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  const handleSend = useCallback((text: string, images?: ImageAttachment[]) => {
    const newId = Crypto.randomUUID();
    setPendingPrompt(newId, { text, cwd: DEV_CWD, images });
    router.replace({
      pathname: "/session/[cliSessionId]",
      params: { cliSessionId: newId, cwd: DEV_CWD },
    });
  }, []);

  const openDrawer = useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);

  return (
    <>
      <Stack.Screen options={{ title: "New session" }} />
      <Stack.Header transparent />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="line.3.horizontal" onPress={openDrawer} />
      </Stack.Toolbar>
      <View className="flex-1 bg-white dark:bg-black">
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
          offset={{ closed: -insets.bottom, opened: -8 }}
          style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
        >
          <InputBar onSend={handleSend} isRunning={false} />
        </KeyboardStickyView>
      </View>
    </>
  );
}
