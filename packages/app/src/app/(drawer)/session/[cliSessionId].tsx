import { KeyboardChatLegendList } from "@legendapp/list/keyboard-chat";
import { Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useMemo } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InputBar } from "@/components/transcript/input-bar";
import { TextBlock } from "@/components/transcript/text-block";
import { ToolBlock } from "@/components/transcript/tool-block";
import { ToolCallSheetProvider } from "@/components/transcript/tool-call-sheet";
import { useLiveSession } from "@/hooks/use-live-session";
import { useDaemonClient } from "@/lib/daemon-client-context";
import { flattenToBlocks, type RenderBlock } from "@/lib/transcript-blocks";
import { DrawerActions } from "expo-router/react-navigation";

/**
 * Detail route. Renders the transcript flattened into per-content-block
 * rows (text + tool) with role attribution managed by a speaker state
 * machine (see flattenToBlocks).
 *
 * Route: /session/<cliSessionId>?title=<encoded>
 *  - cliSessionId: path slug — the canonical conversation identity
 *  - title: query — header label; falls back to "Session" for deeplink
 *    navigations (V0.5+) where the caller didn't have one
 *
 * Live: the route subscribes via `useLiveSession` (settled snapshot +
 * EventDelta tail), and the InputBar's send/stop button toggles on the
 * resulting `isRunning` flag. Send → `client.sendPrompt` (no optimistic
 * UI; daemon synthesizes the user_message append). Stop →
 * `client.interrupt` which targets the SDK query's interrupt and emits
 * a `turn_canceled` event that flips isRunning back.
 */
export default function SessionDetailScreen() {
  const { cliSessionId, title, cwd } = useLocalSearchParams<{
    cliSessionId: string;
    title?: string;
    cwd?: string;
  }>();
  const { client } = useDaemonClient();
  const session = useLiveSession(cliSessionId);
  const insets = useSafeAreaInsets();
  const navigation = useNavigation("/(drawer)/session");

  const openDrawer = useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);

  const handleSend = useCallback(
    (text: string) => {
      if (!client) return;
      // cwd is required for the SDK's project-key resolution on `--resume`.
      // For sessions opened from the list, cwd is plumbed through route
      // params; deeplink / direct nav (V0.5+) will need a fallback fetch.
      void client.sendPrompt(cliSessionId, text, cwd).catch((err) => {
        console.error("sendPrompt failed", err);
      });
    },
    [client, cliSessionId, cwd],
  );

  const handleInterrupt = useCallback(() => {
    if (!client) return;
    void client.interrupt(cliSessionId).catch((err) => {
      console.error("interrupt failed", err);
    });
  }, [client, cliSessionId]);

  return (
    <>
      {/* Title via Stack.Screen options. Header chrome (transparent + Liquid
          Glass blur) and the hamburger button via the new SDK 56 Stack.Header
          / Stack.Toolbar APIs — these render natively (UIKit
          UINavigationBar), so the system handles blur strength tracking with
          scroll, dynamic-type sizing, RTL, etc. */}
      <Stack.Screen options={{ title: title || "Session" }} />
      <Stack.Header transparent blurEffect="systemMaterial" />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="line.3.horizontal" onPress={openDrawer} />
      </Stack.Toolbar>
      <ToolCallSheetProvider>
        <View className="flex-1 bg-white dark:bg-black">
          {session.lastError ? (
            <View className="border-b border-red-300 bg-red-50 px-4 py-2 dark:border-red-800 dark:bg-red-950">
              <Text className="text-xs font-medium text-red-700 dark:text-red-300">
                Turn failed
              </Text>
              <Text
                selectable
                className="mt-0.5 text-xs text-red-600 dark:text-red-400"
              >
                {session.lastError}
              </Text>
            </View>
          ) : null}
          <Body session={session} bottomInset={insets.bottom} />
          {/* InputBar floats over the list so transcript content can scroll
              behind it — Liquid Glass needs content underneath to actually
              blur. KeyboardStickyView's translateY math is
              `height.value + offset(progress)` where height is 0 when
              closed and -keyboardHeight when open. We want to shift UP by
              insets.bottom when closed (so the bar clears the home
              indicator) → closed: -insets.bottom. opened: -12 lifts a bit
              extra above the keyboard top. */}
          <KeyboardStickyView
            offset={{ closed: -insets.bottom, opened: -12 }}
            style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
          >
            <InputBar
              onSend={handleSend}
              onInterrupt={handleInterrupt}
              isRunning={session.isRunning}
            />
          </KeyboardStickyView>
        </View>
      </ToolCallSheetProvider>
    </>
  );
}

function Body({
  session,
  bottomInset,
}: {
  session: ReturnType<typeof useLiveSession>;
  bottomInset: number;
}) {
  if (session.isInitialLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }

  if (session.error) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-base font-medium text-red-600 dark:text-red-400">
          Couldn't load messages
        </Text>
        <Text className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">
          {session.error.message}
        </Text>
      </View>
    );
  }

  return <Transcript items={session.items} bottomInset={bottomInset} />;
}

function Transcript({
  items,
  bottomInset,
}: {
  items: import("@sidecodeapp/protocol").TimelineItem[];
  bottomInset: number;
}) {
  const blocks = useMemo(() => flattenToBlocks(items), [items]);

  if (blocks.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-sm text-gray-500 dark:text-gray-400">
          No content.
        </Text>
      </View>
    );
  }

  return (
    <KeyboardChatLegendList<RenderBlock>
      data={blocks}
      keyExtractor={(b) => b.id}
      renderItem={({ item }) =>
        item.kind === "text" ? (
          <TextBlock block={item} />
        ) : (
          <ToolBlock block={item} />
        )
      }
      // Mixed-block heuristic: short user bubble ~60pt, assistant text
      // ~100pt, tool block ~50pt (sheet-on-tap, no inline expanded
      // content). ~80 is a defensible average; the list re-measures
      // actual sizes after first render.
      estimatedItemSize={80}
      contentContainerStyle={{ paddingBottom: 194 + bottomInset }}
      // Chat-mode triple: stick rendered content to the bottom when it
      // doesn't fill the screen (alignItemsAtEnd), boot directly at the
      // latest message (initialScrollAtEnd), keep the viewport pinned to
      // the bottom whenever the user is already near it (maintainScroll-
      // AtEnd). User scrolling up disengages the pin automatically.
      initialScrollAtEnd
      alignItemsAtEnd
      maintainScrollAtEnd={{ animated: true }}
      // Keep already-visible content's absolute position stable when new
      // items arrive or the keyboard toggles — the Telegram/iMessage
      // "what I'm reading doesn't jump" behavior. Chat-only.
      maintainVisibleContentPosition
      // iOS pull-down-to-dismiss for the keyboard.
      keyboardDismissMode="interactive"
      // Tell the list about the bottom safe-area inset so its scroll
      // calculations (anchoredEndSpace, end detection) account for it.
      offset={bottomInset - 12}
      recycleItems
    />
  );
}
