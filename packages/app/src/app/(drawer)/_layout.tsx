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
 * `drawerType: "slide"` — drawer + main content slide together (drawer
 * pushes content rightward instead of overlaying). Closer to Claude iOS /
 * Notion / Cursor card-peel pattern than the default `front` overlay.
 *
 * `swipeEdgeWidth: 120` — leftmost 120pt is swipe-to-open hot zone. Wide
 * enough to feel responsive but bounded so it doesn't fight horizontal-
 * scroll content (DiffsView etc) in the main pane.
 *
 * Note: expo-router 56 vendor'd a stripped-down `@react-navigation/drawer`
 * (only `drawerStyle` exposed; no `sceneContainerStyle` / `screenLayout`).
 * The "rounded card peel" effect on the main content edge can't be done
 * via screenOptions — would need per-screen wrapping or upstream PR.
 * Deferred to V0.5+ polish.
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
        drawerType: "slide",
        drawerStyle: {
          width: "100%",
          backgroundColor: scheme === "dark" ? "#000000" : "#ffffff",
        },
        // Slide drawerType already moves content together with drawer; an
        // overlay tint isn't needed and would just dim the visible main
        // content edge during the slide.
        overlayColor: "transparent",
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
