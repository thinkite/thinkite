import * as SecureStore from "expo-secure-store";

/**
 * Persistent "last-used cwd" — the path the user most recently picked
 * or opened on THIS device. Drives the new-session screen's default
 * cwd so users don't have to repick every time.
 *
 * Why client-side (not server-side):
 *   - Multi-device semantics: each iOS should remember its own user's
 *     current focus; merging across devices on the daemon would force
 *     a single shared "recent" that's wrong on both.
 *   - Decouples "current intent" (a UX concept) from "session activity"
 *     (a record-keeping concept). Daemon's recentCwds stays the
 *     candidate LIST for the picker; client's lastUsedCwd is the
 *     DEFAULT selection out of that list.
 *   - Works around a known V0 gap: sidecode-created sessions don't
 *     bump their metadata `lastActivityAt` on each turn (see
 *     sidecode-sessions.ts), so server's recentCwds[0] is stale for
 *     active sidecode sessions. The client value, set on each send /
 *     session open, stays fresh.
 *   - Survives daemon restart; lost only on iOS reinstall — at which
 *     point the new-session screen falls back to server's
 *     recentCwds[0] (still a sensible default).
 *
 * SecureStore vs AsyncStorage: SecureStore is overkill from a sensitivity
 * standpoint (cwd isn't a secret), but it's simpler for a single
 * scalar value than pulling in AsyncStorage just for this, and we
 * already use SecureStore elsewhere for pair state. v1 suffix lets
 * us evolve the stored shape without colliding with stale entries.
 */

const KEY = "sidecode.lastUsedCwd.v1";

export async function getLastUsedCwd(): Promise<string | null> {
  return SecureStore.getItemAsync(KEY);
}

export async function setLastUsedCwd(cwd: string): Promise<void> {
  await SecureStore.setItemAsync(KEY, cwd);
}

/** Dev helper — wipes the persisted entry so the next read returns
 *  null. Used by the drawer's "Clear last cwd" __DEV__ button to test
 *  the brand-new-install placeholder state without reinstalling. */
export async function clearLastUsedCwd(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
