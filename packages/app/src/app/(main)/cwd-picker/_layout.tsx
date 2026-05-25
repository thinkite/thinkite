import { Stack } from "expo-router";

/**
 * Inner Stack for the cwd-picker pageSheet. Mirrors `settings/_layout.tsx`
 * — registered at `(main)/_layout.tsx` as `presentation: "pageSheet"`, this
 * inner Stack lets each folder tap push a new in-sheet route (native
 * edge-swipe back included) without stacking a second sheet on top.
 *
 * URL model: single route `index.tsx` with `?path=…` query param. Every
 * folder push reuses the same pathname, only params change → `router.push`
 * creates a fresh instance per push (default react-navigation behavior),
 * so the stack history naturally maps to the breadcrumb path.
 *
 * Header shown but transparent + empty: page-level `<Stack.Toolbar
 * placement="left">` renders the always-on Cancel (X) into the top-left
 * slot per iOS HIG picker convention. `headerShown: true` must be static
 * here (NOT toggled per-page) — react-native-screens warns "dynamically
 * changing header's visibility in modals will result in remounting the
 * screen." `headerTransparent` keeps the bar blended into the sheet (no
 * opaque divider), `headerTitle: ""` avoids competing with the bottom
 * toolbar's basename label, and `headerBackVisible: false` suppresses
 * the native chevron since back is also a bottom-toolbar control.
 */
export default function CwdPickerLayout() {
  return (
    <Stack
      screenOptions={{
        headerShown: true,
        headerTransparent: true,
        headerTitle: "",
        headerBackVisible: false,
      }}
    />
  );
}
