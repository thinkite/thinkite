import * as SecureStore from "expo-secure-store";

/**
 * The user's theme preference — what the Settings → General → Appearance menu
 * stores. "system" follows the OS; "light"/"dark" force the scheme.
 *
 * Persisted per-device in SecureStore (same store family as last-used-cwd —
 * overkill security-wise, but we already depend on it and it beats pulling in
 * AsyncStorage for one scalar). v1 suffix lets the stored shape evolve.
 *
 * Why stored separately from uniwind's runtime theme: `Uniwind.currentTheme`
 * resolves "system" down to the concrete light/dark, so it can't tell "follow
 * the OS" apart from an explicit light/dark pick. We need the raw intent.
 */
export type ThemePref = "light" | "dark" | "system";

const KEY = "sidecode.theme.v1";

export async function getThemePreference(): Promise<ThemePref> {
  const v = await SecureStore.getItemAsync(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export async function setThemePreference(pref: ThemePref): Promise<void> {
  await SecureStore.setItemAsync(KEY, pref);
}
