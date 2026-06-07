import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { Uniwind } from "uniwind";
import {
  getThemePreference,
  setThemePreference,
  type ThemePref,
} from "@/lib/theme-preference";

const QUERY_KEY = ["themePreference"] as const;

/**
 * Current theme preference (light / dark / system), for the Settings Appearance
 * menu. Backed by SecureStore through react-query — mirrors use-last-used-cwd.
 */
export function useThemePreference() {
  return useQuery({ queryKey: QUERY_KEY, queryFn: getThemePreference });
}

/**
 * Apply + persist a theme preference. `Uniwind.setTheme` is the single lever:
 * it flips the `dark:` className variants AND calls `Appearance.setColorScheme`
 * under the hood, so every RN `useColorScheme()` consumer and the expo-router
 * nav theme follow in one shot. The query cache update keeps the menu's
 * checkmark in sync; the SecureStore write is fire-and-forget.
 */
export function useSetThemePreference() {
  const queryClient = useQueryClient();
  return useCallback(
    (pref: ThemePref) => {
      Uniwind.setTheme(pref);
      queryClient.setQueryData(QUERY_KEY, pref);
      void setThemePreference(pref);
    },
    [queryClient],
  );
}
