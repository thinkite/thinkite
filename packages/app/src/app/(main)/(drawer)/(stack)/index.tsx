import { mintMessageId, parseModelRef } from "@thinkite/oc-client";
import type { ImageAttachment } from "@thinkite/protocol";
import { router, Stack } from "expo-router";
import { useCallback } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import {
  KeyboardAvoidingView,
  KeyboardController,
} from "react-native-keyboard-controller";
import { GitStatusBar } from "@/components/transcript/git-status-bar";
import { InputBar } from "@/components/transcript/input-bar";
import { useFilesystemRoots } from "@/hooks/use-filesystem-roots";
import { useLastUsedCwd, useSetLastUsedCwd } from "@/hooks/use-last-used-cwd";
import { useDrawerUI } from "@/lib/drawer-ui";
import { getOcClient, sendUserMessage } from "@/lib/sessions-collection";

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
 * Flow on first send (stage 3b-1: opencode over the iroh HTTP tunnel):
 *   1. `getOcClient().createSession({ location.directory: cwd })` on the
 *      daemon's opencode — it mints the canonical `ses_*` id.
 *   2. Fire the first prompt under a client-minted `msg_*` id
 *      (`sendUserMessage`) so the durable admitted event echoes it and
 *      the transcript can reconcile the optimistic bubble once 3b-2
 *      swaps that screen. A failed prompt still leaves a valid empty
 *      session to type into.
 *   3. `router.replace("/session/[cliSessionId]")` with the `ses_*` id.
 *      Until 3b-2 the detail screen runs the old daemon-RPC transcript
 *      path, finds nothing for that id, and shows its empty state — the
 *      session row is still live in the drawer list.
 */
export default function NewSessionScreen() {
  const { openDrawer } = useDrawerUI();

  // Default cwd: client-side "last used" wins; otherwise fall back to
  // server's most-recent activity. Both can be undefined on a brand-
  // new install — handleSend gates on cwd being defined.
  const { data: lastUsedCwd } = useLastUsedCwd();
  const { data: roots } = useFilesystemRoots();
  const cwd = lastUsedCwd ?? roots?.recentCwds[0]?.path ?? undefined;
  const setLastUsedCwd = useSetLastUsedCwd();

  // Raw send — invoked for non-slash text AND for whitelisted
  // passthrough commands (/init, /review). On new-session only those
  // two passthrough commands are reachable; intercept commands aren't
  // in the new-session picker so the slash hook never dispatches
  // /clear or /model from here. Images are not admitted yet on this
  // path (3b-2), so only `text` rides out on the prompt.
  const rawSend = useCallback(
    (text: string, _images: ImageAttachment[] | undefined, model: string) => {
      if (cwd === undefined) {
        // Placeholder state — user hasn't picked and there's no
        // recent history to fall back on. InputBar.canSend already
        // gates on text/images presence; this is the extra cwd gate
        // so we don't create a session in an unknown directory.
        return;
      }
      // Refresh "last used" so subsequent new-session opens default
      // to this same cwd even before opencode records the activity.
      setLastUsedCwd.mutate(cwd);
      void (async () => {
        try {
          const session = await getOcClient().createSession({
            directory: cwd,
            // The input bar's picker still lists Claude ids until 3b-2;
            // only a `provider/model` ref is meaningful to opencode — a
            // bare id parses to `{providerID: id, id: ""}` and the runner
            // fails the turn with ModelUnavailable (seen live). Omit it
            // and let opencode pick its default.
            ...(model.includes("/") ? { model: parseModelRef(model) } : {}),
          });
          void sendUserMessage({
            sessionId: session.id,
            userMessageUuid: mintMessageId(),
            text,
          }).isPersisted.promise.catch((err: unknown) => {
            console.warn("[new-session] first prompt failed:", err);
          });
          router.replace({
            pathname: "/session/[cliSessionId]",
            params: { cliSessionId: session.id, cwd },
          });
        } catch (err) {
          Alert.alert(
            "Couldn't create session",
            err instanceof Error ? err.message : String(err),
          );
        }
      })();
    },
    [cwd, setLastUsedCwd],
  );

  const openCwdPicker = useCallback(() => {
    // Push the cwd-picker modal route. The sheet runs `setLastUsedCwd`
    // itself on confirm and pops via `router.dismissTo("/")` — this
    // screen just needs to open it. No callback wiring needed; the
    // `useLastUsedCwd()` query above re-fires on mutation invalidate.
    router.push("/cwd-picker");
  }, []);

  return (
    <>
      <Stack.Screen options={{ title: "" }} />
      <Stack.Header transparent />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="line.3.horizontal" onPress={openDrawer} />
      </Stack.Toolbar>
      <View className="flex-1 bg-white dark:bg-black pb-safe">
        <KeyboardAvoidingView
          behavior="padding"
          className="flex-1"
          keyboardVerticalOffset={8}
        >
          {/* Tap anywhere in the empty heading area to dismiss the
              keyboard — standard iOS chat pattern. `KeyboardController.dismiss()`
              from react-native-keyboard-controller goes through the same
              worklet pipeline as KAV's translate, so the close animation
              stays synced with the heading sliding back down (vs RN's
              `Keyboard.dismiss()` which can lag by a frame).
              `accessible={false}` so VoiceOver skips this dead-space
              control instead of announcing "button". InputBar lives
              OUTSIDE this Pressable so its own taps still focus the
              TextInput. */}
          <Pressable
            accessible={false}
            onPress={() => KeyboardController.dismiss()}
            className="flex-1 items-center justify-center px-6"
          >
            <Text className="text-2xl font-semibold text-black dark:text-white">
              New session
            </Text>
          </Pressable>

          {/* Composer chrome — GitStatusBar (cwd picker trigger) sits
            above InputBar inside the same KeyboardStickyView so they
            translate as one unit when the keyboard moves. Picker mode:
            cwd display + tap target only, `+N -M` hidden since the user
            is choosing a project, not reviewing its diff state.
            `offset.closed: -insets.bottom` lifts the composer above the
            home indicator (KSV is absolutely-positioned at bottom: 0,
            which is below the safe area); `offset.opened: -8` leaves an
            8pt visual gap above the keyboard.
            NOTE (likely stale — kept as history): an earlier attempt to
            collapse this into a single KeyboardAvoidingView misaligned the
            InputBar's `+` button on first keyboard show. The cause was
            @expo/ui's SwiftUI Menu Host async measurement + an iOS IME
            candidate-bar bug — BOTH now moot: the `+`/model pickers moved to
            the Nitro menu (@yyq1025/react-native-nitro-menu, pure UIKit, no
            Host), and the @expo/ui Host keyboard bug was fixed upstream. So
            this caveat probably no longer applies. */}
          <View>
            <GitStatusBar
              cwd={cwd}
              onPress={openCwdPicker}
              showChanges={false}
            />
            <InputBar cliSessionId={null} onSend={rawSend} />
          </View>
        </KeyboardAvoidingView>
      </View>
    </>
  );
}
