import { router } from "expo-router";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  Text,
  useColorScheme,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SessionRow } from "@/components/session-row";
import { useSetLastUsedCwd } from "@/hooks/use-last-used-cwd";
import { useSessions } from "@/hooks/use-sessions";
import type { SessionRow as SessionRowData } from "@/lib/sessions-collection";

const Separator = () => <View className="h-px bg-gray-200 dark:bg-gray-800" />;

// Floating-header content height, below the status-bar inset. We set our own
// (instead of react-navigation's getDefaultHeaderHeight, which hardcodes the
// classic 44pt and reads a touch short against the iOS 26 nav bar). Tune freely.
const HEADER_CONTENT_HEIGHT = 52;

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
 *
 * Header chrome: a plain absolute View floats over the list with a
 * linear-gradient scrim (`experimental_backgroundImage`) + the brand title and
 * "+ New" button. (Was a `@react-navigation/elements` Header, dropped — we
 * overrode every slot anyway and its getDefaultHeaderHeight 44pt read short on
 * iOS 26; height is now `HEADER_CONTENT_HEIGHT`.) We also tried the native iOS
 * 26 soft scroll-edge effect (react-native-screens' experimental gamma `Stack`
 * + `ScrollViewMarker`) and an expo-blur `BlurView` — the soft edge works but
 * the gamma header items don't render nested in the drawer, and the blur read
 * as flat — so we keep this simple gradient. See memory
 * `project_sidebar_scrolledge_spike`.
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
  const scheme = useColorScheme() ?? "light";

  // Full floating-header band = status-bar inset + content height. Shared with
  // the list's contentContainerStyle.paddingTop (see Body) so row 1 starts
  // just below the bar.
  const headerHeight = insets.top + HEADER_CONTENT_HEIGHT;

  // 3-stop scrim: HOLD full opacity through the status-bar + title band
  // (0%→75%), then fade only the bottom edge (75%→100%) so the area under the
  // title stays solid and just the sliver where list rows emerge softens.
  // Knobs: move the 75% breakpoint (higher = more solid, shorter fade) and/or
  // raise the end alpha above 0 to keep the bottom edge tinted. Raw CSS string
  // for RN's `experimental_backgroundImage` (key is still `experimental_`-
  // prefixed in RN 0.85.3; plain `backgroundImage` no-ops).
  const headerScrim =
    scheme === "dark"
      ? "linear-gradient(to bottom, rgba(0,0,0,0.95) 0%, rgba(0,0,0,0.8) 80%, rgba(0,0,0,0) 100%)"
      : "linear-gradient(to bottom, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.8) 80%, rgba(255,255,255,0) 100%)";

  // Drawer-style switching uses `router.replace` not `push`: tapping a
  // session in the sidebar should swap the active screen, not accumulate a
  // back stack of session instances. With `push`, switching A → B → A
  // builds Stack [A, B, A] (because the inner Stack's [cliSessionId] route
  // treats different params as different instances by default), and the
  // user gets a back chevron in the UINavigationBar that pops to a session
  // they don't expect to "go back" to.
  const setLastUsedCwd = useSetLastUsedCwd();
  const handleOpenSession = (session: SessionRowData) => {
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
    <View className="flex-1 bg-white dark:bg-black">
      {/* Session list — fills the panel and scrolls UNDER the floating
          header. Its contentContainerStyle.paddingTop (see Body) reserves
          the header band so row 1 starts just below it, then rows fade into
          the scrim as they scroll up. */}
      <Body
        query={query}
        sessions={sessions ?? []}
        onOpenSession={handleOpenSession}
        headerHeight={headerHeight}
      />

      {/* Floating header — one absolute band. Gradient scrim fills the box
          (incl. the status bar); `pt-safe` drops the title/+New row below the
          status-bar inset; flex-row + items-center lay them out. `box-none`
          lets taps on empty header area fall through to the list. */}
      <View
        pointerEvents="box-none"
        className="absolute inset-x-0 top-0 z-10 flex-row items-center justify-between px-4 pt-safe"
        style={{
          height: headerHeight,
          experimental_backgroundImage: headerScrim,
        }}
      >
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
    </View>
  );
}

function Body({
  query,
  sessions,
  onOpenSession,
  headerHeight,
}: {
  query: ReturnType<typeof useSessions>;
  sessions: readonly SessionRowData[];
  onOpenSession: (s: SessionRowData) => void;
  headerHeight: number;
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

  if (sessions.length === 0) {
    return (
      <View className="flex-1 items-center justify-center px-6">
        <Text className="text-center text-sm text-gray-500 dark:text-gray-400">
          No sessions yet.
        </Text>
      </View>
    );
  }

  // Flat list, recency-first per [[project_v0_session_list_design]]. Sort
  // already done by useSessions' `orderBy` so the data prop is the
  // render order.
  return (
    <FlatList<SessionRowData>
      style={{ flex: 1 }}
      data={sessions as SessionRowData[]}
      keyExtractor={(item) => item.cliSessionId}
      renderItem={({ item }) => (
        <SessionRow session={item} onPress={onOpenSession} />
      )}
      ItemSeparatorComponent={Separator}
      // Reserve the floating-header band so row 1 starts just below it; the
      // scroll indicator is inset to match so it doesn't run under the scrim.
      contentContainerStyle={{ paddingTop: headerHeight }}
      scrollIndicatorInsets={{ top: headerHeight }}
      ListFooterComponent={<View className="h-4" />}
    />
  );
}
