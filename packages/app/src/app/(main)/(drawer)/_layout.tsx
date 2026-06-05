import { Drawer } from "expo-router/drawer";
import { Platform, useColorScheme } from "react-native";
import { SessionListSidebar } from "@/components/session-list-sidebar";

const CARD_RADIUS = Platform.OS === "ios" ? 53 : 0;

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
 * `drawerType: "back"` — the drawer sits behind and the main content
 * slides right to reveal it. Combined with `sceneStyle` (borderRadius +
 * boxShadow) the main content reads as a rounded card floating over the
 * sidebar, à la chat-template. The drawer width controls how much card
 * peek remains; at "100%" the card slides fully off-screen when open
 * (no peek), so use < 100% for the persistent-card look.
 *
 * `swipeEdgeWidth: 120` — leftmost 120pt is swipe-to-open hot zone. Wide
 * enough to feel responsive but bounded so it doesn't fight horizontal-
 * scroll content (the diff/code webview) in the main pane.
 *
 * Settings + other modal routes live at the ROOT Stack level (one level
 * above this Drawer), so `router.push("/settings")` slides up modally OVER
 * the entire drawer + main content.
 */
export default function DrawerLayout() {
  const scheme = useColorScheme() ?? "light";
  return (
    <Drawer
      detachInactiveScreens={false}
      drawerContent={(props) => <SessionListSidebar {...props} />}
      screenOptions={{
        drawerType: "back",
        overlayColor: "transparent",
        sceneStyle: {
          borderRadius: CARD_RADIUS,
          borderCurve: "continuous",
          overflow: "hidden",
          boxShadow: "0px 0px 16px rgba(0,0,0,0.15)",
        },
        drawerStyle: {
          width: "80%",
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
