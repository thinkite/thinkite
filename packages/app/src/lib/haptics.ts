import * as Haptics from "expo-haptics";

/**
 * Centralized conversation haptics — the moments and their feels:
 *   - `send`         — user taps send (immediate input confirmation)
 *   - `genStart`     — Claude's first assistant text block opens (the turn's
 *                      first live `append { assistant_message }`, after any
 *                      thinking / tool wait — see transcript-collection-factory)
 *   - `genEnd`       — the turn completes
 *   - `drawerToggle` — the session drawer commits to opening/closing (tap or
 *                      gesture release — the `open` flip, see (drawer)/_layout)
 *
 * Fire-and-forget + error-isolated: `expo-haptics` rejects on the iOS
 * simulator and unsupported devices, and we never want that to surface as an
 * unhandled rejection or block the caller. Centralized in one module so a
 * future "Haptics" setting can gate all of them in a single place.
 */
function fire(p: Promise<void>): void {
  p.catch(() => {});
}

export const haptics = {
  send: () => fire(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  genStart: () => fire(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft)),
  genEnd: () =>
    fire(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  // Selection tick, not an impact: drawerToggle fires at the commit moment
  // (finger on glass, animation starting), where even Soft impact reads
  // heavy on top of the tap's own feel. UISelectionFeedbackGenerator is
  // the system's vocabulary for exactly this (UISwitch et al).
  drawerToggle: () => fire(Haptics.selectionAsync()),
};
