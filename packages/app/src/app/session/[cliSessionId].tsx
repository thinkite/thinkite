import { Stack, useLocalSearchParams } from "expo-router";
import { ActivityIndicator, FlatList, Text, View } from "react-native";
import { useMessages } from "@/hooks/use-messages";
import { SafeAreaView } from "@/lib/styled";

/**
 * Slice B: detail route. JSON-dumps the message array so we can verify the
 * pipe (iOS → daemon → SDK getSessionMessages → JSONL on disk). Slice C
 * replaces the dump with proper user/assistant/tool_use components.
 *
 * Route: /session/<cliSessionId>?cwd=<path>&title=<encoded>
 *  - cliSessionId: path slug — the canonical conversation identity
 *  - cwd: query — passed to daemon's getMessages so the SDK skips its
 *    all-projects scan
 *  - title: query — header label; falls back if the user navigated here
 *    via deeplink (V0.5+) without one
 */
export default function SessionDetailScreen() {
  const { cliSessionId, cwd, title } = useLocalSearchParams<{
    cliSessionId: string;
    cwd: string;
    title?: string;
  }>();
  const query = useMessages(cliSessionId, cwd);

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

  const messages = query.data ?? [];

  if (messages.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-sm text-gray-500 dark:text-gray-400">
          No messages.
        </Text>
      </View>
    );
  }

  // FlatList virtualizes per-message — a single <Text> with the whole
  // JSON.stringify(...) was rendering blank for 50+ message sessions. Each
  // item is a small standalone JSON dump until Slice C does proper rendering.
  return (
    <FlatList
      data={messages}
      keyExtractor={(_, i) => String(i)}
      ListHeaderComponent={
        <View className="px-4 pt-3 pb-1">
          <Text className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
            {messages.length} message{messages.length === 1 ? "" : "s"}
          </Text>
        </View>
      }
      renderItem={({ item, index }) => (
        <View className="border-b border-gray-200 px-4 py-2 dark:border-gray-800">
          <Text className="mb-1 text-xs text-gray-500 dark:text-gray-400">
            #{index}
          </Text>
          <Text selectable className="text-xs text-black dark:text-white">
            {JSON.stringify(item, null, 2)}
          </Text>
        </View>
      )}
    />
  );
}
