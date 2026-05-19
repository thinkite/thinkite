import { Drawer } from "expo-router/drawer";
import { useColorScheme } from "react-native";
import { SessionListSidebar } from "@/components/session-list-sidebar";

/**
 * Drawer layout — wraps the session screens with a sidebar (custom
 * drawerContent rendering the session list + user pill). Modeled on Claude
 * iOS / ChatGPT iOS: tap a session in sidebar → switch active screen,
 * tap "+" → switch back to /session (the new-session create page).
 *
 * Sole child is the `(stack)` group (see ./(stack)/_layout.tsx) — its
 * inner Stack contains both the new-session page (`index` → URL `/`) and
 * the detail page (`session/[cliSessionId]` → URL `/session/<id>`). All
 * app navigation happens inside that Stack via `router.replace`. The
 * `(stack)` group is invisible in URLs, so cold launch lands on `/` (the
 * new-session page) directly without any redirect.
 *
 * Default `drawerType: "front"` — drawer slides over the main content
 * with a system-managed dim overlay. Width 85% leaves a peek of the
 * underlying screen, matching Claude.ai mobile / standard nav-drawer style.
 *
 * `swipeEdgeWidth: 120` — leftmost 120pt is swipe-to-open hot zone. Wide
 * enough to feel responsive but bounded so it doesn't fight horizontal-
 * scroll content (DiffsView etc) in the main pane.
 *
 * Settings + other modal routes live at the ROOT Stack level (one level
 * above this Drawer), so `router.push("/settings")` slides up modally OVER
 * the entire drawer + main content.
 */
export default function DrawerLayout() {
  const scheme = useColorScheme() ?? "light";
  return (
    <Drawer
      drawerContent={(props) => <SessionListSidebar {...props} />}
      screenOptions={{
        drawerType: "back",
        drawerStyle: {
          width: "85%",
          backgroundColor: scheme === "dark" ? "#000000" : "#ffffff",
        },
        swipeEdgeWidth: 120,
        headerShown: false,
      }}
    >
      {/* `(stack)` is a nested Stack group (see ./(stack)/_layout.tsx) —
          register the group as a single Drawer screen, not the inner
          leaves. The leaves are mounted by the inner Stack and inherit
          this screen's drawer placement. */}
      <Drawer.Screen name="(stack)" />
    </Drawer>
  );
}
