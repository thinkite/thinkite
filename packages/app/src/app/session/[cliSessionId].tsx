import { Stack, useLocalSearchParams } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { TextBlock } from "@/components/transcript/text-block";
import { ToolBlock } from "@/components/transcript/tool-block";
import { useMessages } from "@/hooks/use-messages";
import { SafeAreaView } from "@/lib/styled";
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

  return (
    <>
      <Stack.Screen
        options={{
          title: title || "Session",
          headerBackTitle: "Sessions",
        }}
      />
      <SafeAreaView
        className="flex-1 bg-white dark:bg-black"
        edges={["bottom"]}
      >
        <Body query={query} />
      </SafeAreaView>
    </>
  );
}

function Body({ query }: { query: ReturnType<typeof useMessages> }) {
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
  return <Transcript items={items} />;
}

function Transcript({
  items,
}: {
  items: import("@sidecodeapp/protocol").TimelineItem[];
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
    <FlatList<RenderBlock>
      data={blocks}
      keyExtractor={(b) => b.id}
      renderItem={({ item }) =>
        item.kind === "text" ? (
          <TextBlock block={item} />
        ) : (
          <ToolBlock block={item} />
        )
      }
    />
  );
}
