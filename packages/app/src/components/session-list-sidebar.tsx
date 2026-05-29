import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useMemo } from "react";
import {
  ActivityIndicator,
  Pressable,
  SectionList,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionRow } from "@/components/session-row";
import { useSetLastUsedCwd } from "@/hooks/use-last-used-cwd";
import { useSessions } from "@/hooks/use-sessions";
import { projectName } from "@/lib/format";
import { clearLastUsedCwd } from "@/lib/last-used-cwd";
import type { SessionInfo } from "@/types/session";

interface ProjectSection {
  title: string;
  /** Parent project root used as the section's identity / group key. Forks
   *  in worktrees fold into the parent's section via this. */
  originCwd: string;
  data: SessionInfo[];
}

const Separator = () => <View className="h-px bg-gray-200 dark:bg-gray-800" />;

/**
 * Custom drawerContent. Replaces the default react-navigation drawer item
 * list with: app title + recents (sectioned by project) + bottom user pill.
 *
 * The trigger row pattern mirrors Claude iOS: tap a session → close drawer →
 * navigate to the session detail. Tap "+" / new-session → close drawer →
 * navigate to "/" (the new-session create page; lives at
 * `(drawer)/(stack)/index.tsx`, sibling of the detail inside the same
 * inner Stack). Tap user pill → router.push("/settings") → root Stack
 * pushes the modal sheet over (drawer).
 *
 * Drawer's `navigation` prop only needs `closeDrawer`; full
 * `DrawerContentComponentProps` shape lives at
 * `node_modules/expo-router/build/react-navigation/drawer/types.d.ts:178` but
 * isn't re-exported from a clean public path — typing inline keeps the import
 * surface small.
 */
interface SidebarNavigation {
  closeDrawer: () => void;
}

export function SessionListSidebar({
  navigation,
}: {
  navigation: SidebarNavigation;
}) {
  const query = useSessions();
  const sessions = query.data;
  const insets = useSafeAreaInsets();
  const queryClient = useQueryClient();

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

  // Drawer-style switching uses `router.replace` not `push`: tapping a
  // session in the sidebar should swap the active screen, not accumulate a
  // back stack of session instances. With `push`, switching A → B → A
  // builds Stack [A, B, A] (because the inner Stack's [cliSessionId] route
  // treats different params as different instances by default), and the
  // user gets a back chevron in the UINavigationBar that pops to a session
  // they don't expect to "go back" to.
  const setLastUsedCwd = useSetLastUsedCwd();
  const handleOpenSession = (session: SessionInfo) => {
    // Record the current focus so the next "New session" defaults to
    // the project the user just opened. Mutation is fire-and-forget;
    // the navigation below shouldn't wait on SecureStore I/O.
    setLastUsedCwd.mutate(session.cwd);
    navigation.closeDrawer();
    router.replace({
      pathname: "/session/[cliSessionId]",
      params: {
        cliSessionId: session.cliSessionId,
        // No title param — the detail screen reads it from the session's
        // collection row (filtered live query), so it stays correct as
        // the daemon's canonical title lands.
        //
        // Pass cwd so the session screen can hand it to sendPrompt — the
        // SDK derives the project key from cwd to locate the JSONL for
        // `claude --resume`.
        cwd: session.cwd,
      },
    });
  };

  const handleNewSession = () => {
    navigation.closeDrawer();
    // Replace, not push: the new-session page is a sibling of the detail
    // inside the same inner Stack ((drawer)/(stack)/index → URL "/"), so
    // switching to it from a detail screen is a top-of-Stack swap (no
    // back stack accumulating).
    router.replace("/");
  };

  // Settings IS a push — it's a modal at the root Stack level, sliding up
  // OVER the drawer + main content as a pageSheet. Stack semantics (push +
  // dismiss) are correct here.
  const handleOpenSettings = () => {
    router.push("/settings");
  };

  return (
    <View
      className="flex-1 bg-white dark:bg-black"
      style={{ paddingTop: insets.top }}
    >
      {/* Brand title row */}
      <View className="flex-row items-center justify-between px-4 pt-2 pb-3">
        <Text className="text-2xl font-semibold text-black dark:text-white">
          sidecode
        </Text>
        <Pressable
          onPress={handleNewSession}
          hitSlop={8}
          className="rounded-full bg-gray-100 px-3 py-1 dark:bg-gray-800"
        >
          <Text className="text-sm font-medium text-black dark:text-white">
            + New
          </Text>
        </Pressable>
      </View>

      {/* Session list */}
      <Body
        query={query}
        sections={sections}
        onOpenSession={handleOpenSession}
      />

      {/* Bottom user pill — opens settings as modal */}
      <Pressable
        onPress={handleOpenSettings}
        className="flex-row items-center gap-3 border-t border-gray-200 px-4 py-3 dark:border-gray-800"
        style={{ paddingBottom: insets.bottom + 12 }}
      >
        <View className="h-8 w-8 items-center justify-center rounded-full bg-gray-200 dark:bg-gray-700">
          <Text className="text-xs font-semibold text-black dark:text-white">
            RY
          </Text>
        </View>
        <Text className="flex-1 text-sm text-black dark:text-white">
          Settings
        </Text>
      </Pressable>

      {/* Dev shortcuts, only in __DEV__ */}
      {__DEV__ && (
        <>
          <Pressable
            onPress={() => {
              navigation.closeDrawer();
              router.push("/dev/diffs");
            }}
            className="px-4 py-2"
          >
            <Text className="text-xs text-blue-600 dark:text-blue-400">
              Diffs dev →
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              navigation.closeDrawer();
              router.push("/dev/menu-expo");
            }}
            className="px-4 py-2"
          >
            <Text className="text-xs text-blue-600 dark:text-blue-400">
              Menu test (@expo/ui swift-ui) →
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              navigation.closeDrawer();
              router.push("/dev/menu-universal");
            }}
            className="px-4 py-2"
          >
            <Text className="text-xs text-blue-600 dark:text-blue-400">
              Menu test (@expo/ui Universal) →
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              navigation.closeDrawer();
              router.push("/dev/menu-rnm");
            }}
            className="px-4 py-2"
          >
            <Text className="text-xs text-blue-600 dark:text-blue-400">
              Menu test (@react-native-menu) →
            </Text>
          </Pressable>
          <Pressable
            onPress={() => {
              navigation.closeDrawer();
              router.push("/dev/keyboard-extender" as never);
            }}
            className="px-4 py-2"
          >
            <Text className="text-xs text-blue-600 dark:text-blue-400">
              KeyboardExtender spike →
            </Text>
          </Pressable>
          <Pressable
            onPress={async () => {
              await clearLastUsedCwd();
              // Invalidate so subscribers re-read null without needing
              // a Metro reload — lets you toggle the placeholder state
              // back and forth quickly.
              queryClient.invalidateQueries({ queryKey: ["lastUsedCwd"] });
            }}
            className="px-4 py-2"
          >
            <Text className="text-xs text-blue-600 dark:text-blue-400">
              Clear last cwd (test placeholder) →
            </Text>
          </Pressable>
        </>
      )}
    </View>
  );
}

function Body({
  query,
  sections,
  onOpenSession,
}: {
  query: ReturnType<typeof useSessions>;
  sections: ProjectSection[];
  onOpenSession: (s: SessionInfo) => void;
}) {
  if (query.isLoading) {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }

  if (query.isError) {
    // useLiveQuery surfaces error state via `status`/`isError` but not an
    // error object — show a static message (the daemon facade retries the
    // underlying fetch forever, so this is a transient first-load state).
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-base font-medium text-red-600 dark:text-red-400">
          Couldn't load sessions
        </Text>
      </View>
    );
  }

  if (sections.length === 0) {
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
      renderItem={({ item }) => (
        <SessionRow session={item} onPress={onOpenSession} />
      )}
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
      ListFooterComponent={<View className="h-4" />}
    />
  );
}
