import { Slot } from "expo-router";
import { useCallback, useMemo, useState } from "react";
import { Platform, useColorScheme, View } from "react-native";
import { Drawer } from "react-native-drawer-layout";
import { SessionListSidebar } from "@/components/session-list-sidebar";
import { DrawerUIContext } from "@/lib/drawer-ui";
import { haptics } from "@/lib/haptics";

const CARD_RADIUS = Platform.OS === "ios" ? 53 : 0;

/**
 * Drawer layout — wraps the session screens with a sidebar (the session
 * list + user pill). Modeled on Claude iOS / ChatGPT iOS: tap a session in
 * sidebar → switch active screen, tap "+" → switch back to /session (the
 * new-session create page).
 *
 * Bare `react-native-drawer-layout`, deliberately NOT a drawer navigator:
 * the drawer hosts no routes (its sole child was ever one screen group),
 * and the navigator hid `open` inside navigation state — the close
 * animation could only be observed via parent-navigator event listeners
 * with no queryable "is animating" (which forced a safety timeout in the
 * session screen's mount gate). As plain React state + direct
 * onTransitionStart/End props, the gate is exact. Visuals are identical —
 * the navigator was a thin wrapper around this same component.
 *
 * Sole child is the `(stack)` group (see ./(stack)/_layout.tsx) — its
 * inner Stack contains both the new-session page (`index` → URL `/`) and
 * the detail page (`session/[cliSessionId]` → URL `/session/<id>`). All
 * app navigation happens inside that Stack via `router.replace`. The
 * `(stack)` group is invisible in URLs, so cold launch lands on `/` (the
 * new-session page) directly without any redirect.
 *
 * `drawerType: "back"` — the drawer sits behind and the main content
 * slides right to reveal it. Combined with the rounded-card wrapper View
 * (borderRadius + boxShadow — the former navigator `sceneStyle`) the main
 * content reads as a card floating over the sidebar, à la chat-template.
 * The drawer width controls how much card peek remains; at "100%" the
 * card slides fully off-screen when open (no peek), so use < 100% for the
 * persistent-card look.
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
  const [open, setOpen] = useState(false);
  const [transitioning, setTransitioning] = useState(false);

  // The `open` guard matters: calling close while already closed must NOT
  // set `transitioning` — no animation would run, so no onTransitionEnd
  // would ever clear it. Setting `transitioning` EAGERLY (same batch as
  // the open flip) is the gate's real mechanism: the component's own
  // onTransitionStart lands a frame later AND doesn't fire at all for
  // gesture-settled transitions (the source skips it when a velocity is
  // passed), while the session screen must see the flag in the same batch
  // as the route change that follows a sidebar tap.
  // Haptics fire at the COMMIT point — the moment `open` actually flips
  // (tap here, gesture release in onOpen/onClose below) — not at the
  // drawer's transition events: onTransitionEnd waits for the spring's
  // mathematical rest (an overdamped sub-pixel tail well past the
  // perceived landing → buzz felt late), and both transition events also
  // fire for the mount-time prop-sync toggle (→ spurious buzz on every
  // reload). Gating on the `open` flip is immediate and skips all echoes.
  const openDrawer = useCallback(() => {
    if (open) return;
    haptics.drawerToggle();
    setTransitioning(true);
    setOpen(true);
  }, [open]);

  const closeDrawer = useCallback(() => {
    if (!open) return;
    haptics.drawerToggle();
    setTransitioning(true);
    setOpen(false);
  }, [open]);

  const drawerUI = useMemo(
    () => ({ open, transitioning, openDrawer, closeDrawer }),
    [open, transitioning, openDrawer, closeDrawer],
  );

  return (
    <DrawerUIContext.Provider value={drawerUI}>
      <Drawer
        open={open}
        onOpen={() => {
          // Gesture-driven open commits here, at release (programmatic
          // open came through openDrawer where `open` is already true —
          // and the mount/resync echoes arrive with `open` unchanged —
          // so the state-change check dedupes all of them).
          if (!open) haptics.drawerToggle();
          setOpen(true);
        }}
        onClose={() => {
          if (open) haptics.drawerToggle();
          setOpen(false);
        }}
        onTransitionStart={() => setTransitioning(true)}
        onTransitionEnd={(closing) => {
          // Direction match — only the end event whose direction agrees
          // with the current target state may clear `transitioning`. A
          // spring that completes (finished=true) right as the OPPOSITE
          // transition is requested delivers its end callback via runOnJS
          // AFTER the new eager setTransitioning(true) — captured on
          // device 2026-06-12: tapping a session row in the same frame the
          // open animation landed let the stale "open ended" event clear
          // the close transition's flag; the gate then released ChatPanel
          // mid-close and the mount choke froze the drawer half-open. A
          // stale end is always opposite-direction (that's what makes it
          // stale), so the check closes the race exactly.
          if (closing !== !open) return;
          setTransitioning(false);
        }}
        drawerType="back"
        overlayStyle={{ backgroundColor: "transparent" }}
        drawerStyle={{
          width: "80%",
          backgroundColor: scheme === "dark" ? "#000000" : "#ffffff",
        }}
        swipeEdgeWidth={120}
        renderDrawerContent={() => <SessionListSidebar />}
      >
        <View
          style={{
            flex: 1,
            borderRadius: CARD_RADIUS,
            borderCurve: "continuous",
            overflow: "hidden",
            boxShadow: "0px 0px 16px rgba(0,0,0,0.15)",
          }}
        >
          <Slot />
        </View>
      </Drawer>
    </DrawerUIContext.Provider>
  );
}
