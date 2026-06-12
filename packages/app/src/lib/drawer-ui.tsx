import { createContext, useContext } from "react";

/**
 * UI state for the session-list drawer (bare react-native-drawer-layout —
 * deliberately NOT a drawer navigator: the drawer hosts no routes, and
 * owning `open`/`transitioning` as plain React state is what lets the
 * session screen gate its heavy ChatPanel mount on the close animation
 * with zero timers, params, or navigation-event plumbing. Provided by
 * the (drawer) group layout.
 *
 * `transitioning` is true from the moment a programmatic open/close is
 * requested (set eagerly, same batch as the `open` flip — the component's
 * own onTransitionStart would arrive a frame late) until the drawer's
 * onTransitionEnd — direction-matched: an end event whose `closing` arg
 * disagrees with the current target state is a stale callback from the
 * superseded opposite transition and is ignored (see the layout's
 * onTransitionEnd comment for the captured race). Gesture-driven
 * transitions are covered by onTransitionStart/onTransitionEnd directly.
 */
export interface DrawerUI {
  open: boolean;
  /** A drawer open/close animation is in flight. */
  transitioning: boolean;
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
