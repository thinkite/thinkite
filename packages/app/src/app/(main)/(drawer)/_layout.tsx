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
 * the drawer hosts no routes (its sole child is one screen group), and the
 * navigator hid `open` inside navigation state — the close animation could
 * only be observed via parent-navigator event listeners with no queryable
 * "is animating" (which forced a safety timeout in the session screen's mount
 * gate). As a plain React `transitioningSessionId` (set in closeDrawer, cleared
 * on the drawer's onTransitionEnd) the gate is exact, and `open` drives the
 * commit-point haptics below. Visuals are identical — the navigator was a thin
 * wrapper around this same component.
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
  const [transitioningSessionId, setTransitioningSessionId] = useState<
    string | null
  >(null);

  // `transitioningSessionId` gates the session screen's ChatPanel mount against
  // the close animation. closeDrawer(toSessionId) records it EAGERLY (same batch
  // as the `open` flip and the sidebar's router.replace) so the session being
  // navigated TO observes it on its very first render — onTransitionStart would
  // land a frame late, and doesn't fire at all for gesture-settled transitions
  // (the source skips it when a velocity is passed). Only a programmatic,
  // navigation-coupled close passes an id; gesture/overlay-tap dismissals and
  // the new-session "+" leave it null (they keep the current session mounted /
  // close toward `/`). openDrawer clears it: a close reversed back into an open
  // before it lands is no longer transitioning.
  //
  // The `open` guard matters: calling close while already closed must NOT set
  // the id — no animation would run, so no onTransitionEnd would clear it.
  //
  // Haptics fire at the COMMIT point — the moment `open` actually flips (tap
  // here, gesture release in onOpen/onClose below) — not at the drawer's
  // transition events: onTransitionEnd waits for the spring's mathematical rest
  // (an overdamped sub-pixel tail well past the perceived landing → buzz felt
  // late), and it also fires for the mount-time prop-sync toggle (→ spurious
  // buzz on every reload). Gating on the `open` flip is immediate and skips all
  // echoes.
  const openDrawer = useCallback(() => {
    if (open) return;
    haptics.drawerToggle();
    setTransitioningSessionId(null);
    setOpen(true);
  }, [open]);

  const closeDrawer = useCallback(
    (toSessionId?: string) => {
      if (!open) return;
      haptics.drawerToggle();
      setTransitioningSessionId(toSessionId ?? null);
      setOpen(false);
    },
    [open],
  );

  const drawerUI = useMemo(
    () => ({ transitioningSessionId, openDrawer, closeDrawer }),
    [transitioningSessionId, openDrawer, closeDrawer],
  );

  return (
    <DrawerUIContext.Provider value={drawerUI}>
      <Drawer
        open={open}
        onOpen={() => {
          // Gesture-driven open commits here, at release (programmatic open
          // came through openDrawer where `open` is already true — and the
          // mount/resync echoes arrive with `open` unchanged — so the
          // state-change check dedupes all of them). Clear the transitioning id
          // too: a swipe that reverses an in-flight close means we're opening now.
          if (!open) haptics.drawerToggle();
          setTransitioningSessionId(null);
          setOpen(true);
        }}
        onClose={() => {
          // Gesture / overlay-tap dismissals land here. They deliberately do
          // NOT set a transitioning id — the current session stays mounted, so
          // gating it would only flicker ChatPanel back to loading. A
          // navigation-coupled close already recorded its id in closeDrawer.
          if (open) haptics.drawerToggle();
          setOpen(false);
        }}
        onTransitionEnd={(isClosing) => {
          // Only a completed CLOSE clears the gate. Open-end events carry
          // closing=false and are ignored — including a stale one delivered
          // via runOnJS AFTER a new close was already requested (captured on
          // device 2026-06-12: a row tapped in the same frame the open landed
          // let the "open ended" callback clear the gate, releasing ChatPanel
          // mid-close and freezing the drawer half-open). Acting only on
          // isClosing closes that race. (onTransitionEnd can't tell WHICH
          // session finished — it just clears whatever id is pending; for a
          // single drawer close that's always the latest target, so correct.)
          if (isClosing) setTransitioningSessionId(null);
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
