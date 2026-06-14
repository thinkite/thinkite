import { createContext, useContext } from "react";

/**
 * UI state for the session-list drawer (bare react-native-drawer-layout —
 * deliberately NOT a drawer navigator: the drawer hosts no routes, and owning
 * `open`/`transitioningSessionId` as plain React state is what lets the session
 * screen gate its heavy ChatPanel mount on the close animation with zero
 * timers, params, or navigation-event plumbing. Provided by the (drawer) group
 * layout.
 *
 * The context exposes the imperative controls (`openDrawer` from the session +
 * new-session hamburger, `closeDrawer` from the sidebar) plus
 * `transitioningSessionId`. `open` itself stays local to the layout (it drives
 * the `<Drawer open>` prop); nothing outside reads it.
 *
 * `transitioningSessionId` names the session a navigation-coupled close is
 * animating TOWARD: `closeDrawer(toSessionId)` fires from a sidebar tap, in the
 * same batch as the `router.replace` to that session, and records the id here
 * (so the session being navigated TO sees it on its first render). The detail
 * screen gates its ChatPanel mount while this equals its own id, then
 * onTransitionEnd clears it to null — or openDrawer/onOpen clears it if the
 * close reverses into an open. It is deliberately NOT set for gesture /
 * overlay-tap dismissals or for the new-session "+" (which closes toward `/`,
 * not a session): those pass no id, so every mounted session has
 * `transitioningSessionId !== its id` and isn't gated. Carrying the id (vs a
 * bare `closing` boolean) also lets the sidebar skip the whole dance when you
 * tap the already-open session — see handleOpenSession.
 */
export interface DrawerUI {
  /** The session a navigation-coupled drawer-close is animating toward, or null
   *  when none is in flight. The detail screen gates its ChatPanel mount while
   *  this equals its own id. */
  transitioningSessionId: string | null;
  openDrawer: () => void;
  /** Close the drawer. `toSessionId` records which session is being navigated
   *  to so its detail screen can gate its mount until the close lands; omit it
   *  for gesture dismissals and the new-session "+" (closes toward `/`). */
  closeDrawer: (toSessionId?: string) => void;
}

export const DrawerUIContext = createContext<DrawerUI | null>(null);

export function useDrawerUI(): DrawerUI {
  const ctx = useContext(DrawerUIContext);
  if (ctx === null) {
    throw new Error("useDrawerUI must be used inside the (drawer) layout");
  }
  return ctx;
}
