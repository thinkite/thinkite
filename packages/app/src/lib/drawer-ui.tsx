import { createContext, useContext } from "react";

/**
 * UI state for the session-list drawer (bare react-native-drawer-layout —
 * deliberately NOT a drawer navigator: the drawer hosts no routes, and
 * owning `open`/`closing` as plain React state is what lets the session
 * screen gate its heavy ChatPanel mount on the close animation with zero
 * timers, params, or navigation-event plumbing. Provided by the (drawer)
 * group layout.
 *
 * `closing` is true only while a programmatic, navigation-coupled close is
 * animating — i.e. the close `closeDrawer` fires from a sidebar tap, paired
 * in the same batch with the `router.replace` to the new session. It is set
 * eagerly in `closeDrawer` (so the screen being navigated TO sees it on its
 * first render) and cleared on the matching onTransitionEnd, or earlier if
 * the close reverses back into an open (openDrawer/onOpen). It is
 * deliberately NOT set for gesture / overlay-tap dismissals or for open
 * transitions: those keep the current session mounted, so a plain
 * `!closing` is all the gate needs (see the session screen). Tracking only
 * the close direction also dissolves the old stale-end race — an open-end
 * callback carries closing=false and is simply ignored.
 */
export interface DrawerUI {
  open: boolean;
  /** A navigation-coupled drawer-close animation is in flight. */
  closing: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
}

export const DrawerUIContext = createContext<DrawerUI | null>(null);

export function useDrawerUI(): DrawerUI {
  const ctx = useContext(DrawerUIContext);
  if (ctx === null) {
    throw new Error("useDrawerUI must be used inside the (drawer) layout");
  }
  return ctx;
}
