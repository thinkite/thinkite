import type { ImageAttachment } from "@sidecodeapp/protocol";
import * as Crypto from "expo-crypto";
import { router, Stack, useNavigation } from "expo-router";
import { DrawerActions } from "expo-router/react-navigation";
import { useCallback } from "react";
import { Text, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GitStatusBar } from "@/components/transcript/git-status-bar";
import { InputBar } from "@/components/transcript/input-bar";
import { useFilesystemRoots } from "@/hooks/use-filesystem-roots";
import { useLastUsedCwd, useSetLastUsedCwd } from "@/hooks/use-last-used-cwd";
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
 * cwd selection precedence:
 *   1. `lastUsedCwd` (SecureStore) — what the user picked or opened
 *      most recently on THIS device. Set on session-row tap (sidebar)
 *      and on send below.
 *   2. `recentCwds[0]` from daemon `getFilesystemRoots` — server's
 *      best guess across all activity, used as the initial bootstrap
 *      default before the user has picked anything on this device.
 *   3. `undefined` — first launch with no session history. GitStatusBar
 *      shows a "Select a project" placeholder + chevron; tap opens the
 *      cwd picker. Send button stays disabled until cwd resolves.
 *
 * Flow on first send:
 *   1. Generate a fresh UUIDv4 client-side
 *   2. Stash the prompt text + cwd in `submission-store` keyed by that UUID
 *   3. `router.replace("/session/[id]")` immediately — the user sees the
 *      detail screen with no perceptible RTT lag
 *   4. Detail screen mounts → `useLiveSession` fires `subscribe` and
 *      awaits its response (so daemon has registered the live fanout
 *      callback). Only then does it consume the pending prompt and fire
 *      `sendPrompt` — guaranteeing user_message + turn_started events
 *      reach the iOS subscriber instead of falling into the cursor
 *      race window. See lib/submission-store.ts for the full rationale.
 */
export default function NewSessionScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();

  // Default cwd: client-side "last used" wins; otherwise fall back to
  // server's most-recent activity. Both can be undefined on a brand-
  // new install — handleSend gates on cwd being defined.
  const { data: lastUsedCwd } = useLastUsedCwd();
  const { data: roots } = useFilesystemRoots();
  const cwd = lastUsedCwd ?? roots?.recentCwds[0]?.path ?? undefined;
  const setLastUsedCwd = useSetLastUsedCwd();

  const handleSend = useCallback(
    (text: string, images?: ImageAttachment[]) => {
      if (cwd === undefined) {
        // Placeholder state — user hasn't picked and there's no
        // recent history to fall back on. InputBar.canSend already
        // gates on text/images presence; this is the extra cwd gate
        // so we don't ship a malformed sendPrompt to the daemon.
        return;
      }
      // Refresh "last used" so subsequent new-session opens default
      // to this same cwd even before the daemon records the activity.
      setLastUsedCwd.mutate(cwd);
      const newId = Crypto.randomUUID();
      setPendingPrompt(newId, { text, cwd, images });
      router.replace({
        pathname: "/session/[cliSessionId]",
        params: { cliSessionId: newId, cwd },
      });
    },
    [cwd, setLastUsedCwd],
  );

  const openDrawer = useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);

  const openCwdPicker = useCallback(() => {
    // TODO: open <CwdPickerSheet /> here. The sheet calls back with
    // the picked path → `setLastUsedCwd.mutate(picked)` → next render
    // sees the new `cwd` via lastUsedCwd preference.
    console.log("[NewSessionScreen] cwd picker not wired yet");
  }, []);

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
            cwd: {cwd ?? "—"}
          </Text>
        </View>

        {/* Composer chrome — GitStatusBar (cwd picker trigger) sits
            above InputBar inside the same KeyboardStickyView so they
            translate as one unit when the keyboard moves. */}
        <KeyboardStickyView
          offset={{ closed: -insets.bottom, opened: -8 }}
          style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
        >
          {/* Picker mode: cwd display + tap target only. `+N -M`
              hidden — user is choosing a project, not reviewing its
              diff state. */}
          <GitStatusBar cwd={cwd} onPress={openCwdPicker} showChanges={false} />
          <InputBar onSend={handleSend} isRunning={false} />
        </KeyboardStickyView>
      </View>
    </>
  );
}
