import { Stack } from "expo-router";
import { ToolCallSheetProvider } from "@/components/transcript/tool-call-sheet";

/**
 * `(stack)` — invisible route group whose only purpose is to wrap the
 * new-session page (`index` → URL `/`) and the detail page
 * (`session/[cliSessionId]` → URL `/session/<id>`) in a shared Stack.
 *
 * Both screens share this Stack so they get a real UIKit
 * `UINavigationBar` (rendered via react-native-screens) instead of
 * @react-navigation/elements's JS-rendered header — on iOS 26+ this is
 * what gets the system Liquid Glass material.
 *
 * Group is named `(stack)` (parens) so it stays out of the URL: `/`
 * (cold launch) lands directly on the new-session page without an extra
 * `/session` segment, and the detail keeps its natural `/session/<id>`
 * path.
 *
 * Sidebar transitions (tap row, "+ New") all use `router.replace` within
 * this Stack so the back stack stays one item deep — switch semantics, not
 * push semantics. The drawer is the cross-screen primitive.
 *
 * `animation: "fade"` matches that semantic — every transition here is a
 * "swap to a different session" rather than a "push deeper", so the
 * default iOS slide-from-right reads as the wrong gesture (it implies a
 * back-stack you can pop). A soft fade is also kinder to the new-session
 * → detail handoff: the user-message bubble materializes inside the
 * already-present detail surface instead of appearing while the slide is
 * still in motion. Switching to `"none"` would be even snappier but
 * leaves the user without any visual cue that the screen swapped.
 *
 * Header config + toolbar (hamburger button → openDrawer) live INSIDE
 * each page component, not here. Reason: `Stack.Toolbar` with `onPress`
 * callbacks needs a `useNavigation()` whose `.getParent()` walks up to the
 * Drawer. From inside the page that works (page's nav = Stack, getParent
 * = Drawer); from this layout file's render scope the navigation context
 * is ambiguous in expo-router 56's vendored navigators.
 */
export default function StackLayout() {
  return (
    // ToolCallSheetProvider lives HERE, above the Stack, rather than inside the
    // detail screen — so the single resident Pierre webview (warm shiki + the
    // off-thread highlight worker pool) and the shared BottomSheet PERSIST across
    // session switches. Switching sessions is a `router.replace` within this
    // Stack: if the provider were per-screen it'd unmount + cold-reinit the
    // webview/workers on every switch. (Trade-off: it also mounts on the
    // new-session `index` screen at cold launch, pre-warming the webview before
    // the first diff/tool open; `index` doesn't consume the context itself.)
    <ToolCallSheetProvider>
      <Stack
        screenOptions={{
          animation: "fade",
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="session/[cliSessionId]" />
      </Stack>
    </ToolCallSheetProvider>
  );
}
