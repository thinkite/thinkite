import { KeyboardChatLegendList } from "@legendapp/list/keyboard-chat";
import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { InputBar } from "@/components/transcript/input-bar";
import { TextBlock } from "@/components/transcript/text-block";
import { ToolBlock } from "@/components/transcript/tool-block";
import { ToolCallSheetProvider } from "@/components/transcript/tool-call-sheet";
import { useMessages } from "@/hooks/use-messages";
import { flattenToBlocks, type RenderBlock } from "@/lib/transcript-blocks";

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
 * No cwd hint: daemon's getMessages does an all-projects scan since fork
 * sessions in worktrees can have their JSONL at either the worktree's
 * project key or originCwd's, with no deterministic rule to pick.
 */
export default function SessionDetailScreen() {
  const { cliSessionId, title } = useLocalSearchParams<{
    cliSessionId: string;
    title?: string;
  }>();
  const query = useMessages(cliSessionId);
  const insets = useSafeAreaInsets();

  return (
    <>
      <Stack.Screen
        options={{
          title: title || "Session",
          headerBackTitle: "Sessions",
        }}
      />
      <ToolCallSheetProvider>
        <View className="flex-1 bg-white dark:bg-black">
          <Body query={query} bottomInset={insets.bottom} />
          {/* InputBar floats over the list so transcript content can scroll
              behind it — Liquid Glass needs content underneath to actually
              blur. KeyboardStickyView's translateY math is
              `height.value + offset(progress)` where height is 0 when
              closed and -keyboardHeight when open. We want to shift UP by
              insets.bottom when closed (so the bar clears the home
              indicator) → closed: -insets.bottom. opened: 0 keeps the bar
              riding the keyboard top exactly. */}
          <KeyboardStickyView
            offset={{ closed: -insets.bottom, opened: -12 }}
            style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
          >
            <InputBar />
          </KeyboardStickyView>
        </View>
      </ToolCallSheetProvider>
    </>
  );
}

function Body({
  query,
  bottomInset,
}: {
  query: ReturnType<typeof useMessages>;
  bottomInset: number;
}) {
  if (query.isPending) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }

  if (query.isError) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-base font-medium text-red-600 dark:text-red-400">
          Couldn't load messages
        </Text>
        <Text className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">
          {query.error instanceof Error
            ? query.error.message
            : String(query.error)}
        </Text>
      </View>
    );
  }

  const items = query.data ?? [];
  return <Transcript items={items} bottomInset={bottomInset} />;
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
      // Clears the absolute-positioned InputBar so the last message can
      // scroll fully visible above it. Estimated input height ≈ 84pt
      // (padding + text + action row); 160pt gives a bit of breathing
      // room. Tune after first sim run.
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
