import { Stack } from "expo-router";
import { useMemo } from "react";
import { ActivityIndicator, SectionList, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { SessionRow } from "@/components/session-row";
import { useSessions } from "@/hooks/use-sessions";
import { projectName } from "@/lib/format";
import type { SessionInfo } from "@/types/session";

interface ProjectSection {
  title: string;
  /** Parent project root used as the section's identity / group key. Forks
   *  in worktrees fold into the parent's section via this. */
  originCwd: string;
  data: SessionInfo[];
}

const Separator = () => (
  <View className="h-px bg-gray-200 dark:bg-gray-800" />
);

export default function SessionsScreen() {
  const query = useSessions();

  return (
    <>
      <Stack.Screen options={{ headerShown: false }} />
      <SafeAreaView className="flex-1 bg-white dark:bg-black" edges={["top"]}>
        <View className="px-4 pt-4 pb-3">
          <Text className="text-2xl font-semibold text-black dark:text-white">
            Sessions
          </Text>
        </View>
        <Body query={query} />
      </SafeAreaView>
    </>
  );
}

function Body({ query }: { query: ReturnType<typeof useSessions> }) {
  const sessions = query.data;

  const sections = useMemo<ProjectSection[]>(() => {
    if (!sessions) return [];
    // Group by originCwd so fork sessions in worktrees fold under their
    // parent project. cwd is the actual run dir (worktree); originCwd is
    // the parent root — see project_desktop_session_storage memory.
    const buckets = new Map<string, SessionInfo[]>();
    for (const s of sessions) {
      const arr = buckets.get(s.originCwd);
      if (arr) arr.push(s);
      else buckets.set(s.originCwd, [s]);
    }
    const groups = Array.from(buckets, ([originCwd, data]) => {
      const mostRecent = Math.max(...data.map((d) => d.lastActivityAt));
      return { originCwd, data, mostRecent };
    });
    groups.sort((a, b) => b.mostRecent - a.mostRecent);
    return groups.map(({ originCwd, data }) => ({
      title: projectName(originCwd),
      originCwd,
      data,
    }));
  }, [sessions]);

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
          Couldn't load sessions
        </Text>
        <Text className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">
          {query.error instanceof Error ? query.error.message : String(query.error)}
        </Text>
      </View>
    );
  }

  if (!sessions || sessions.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-sm text-gray-500 dark:text-gray-400">
          No sessions yet.
        </Text>
      </View>
    );
  }

  return (
    <SectionList<SessionInfo, ProjectSection>
      sections={sections}
      keyExtractor={(item) => item.cliSessionId}
      renderItem={({ item }) => <SessionRow session={item} />}
      ItemSeparatorComponent={Separator}
      renderSectionHeader={({ section }) => (
        <View className="bg-gray-50 px-4 pt-4 pb-1 dark:bg-gray-950">
          <Text
            numberOfLines={1}
            className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400"
          >
            {section.title}
          </Text>
        </View>
      )}
      stickySectionHeadersEnabled
      ListFooterComponent={<View className="h-8" />}
    />
  );
}
