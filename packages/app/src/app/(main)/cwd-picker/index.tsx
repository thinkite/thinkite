import { Host, Text as UiText } from "@expo/ui";
import { frame, padding } from "@expo/ui/swift-ui/modifiers";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { FolderList } from "@/components/cwd-picker/folder-list";
import { useSetLastUsedCwd } from "@/hooks/use-last-used-cwd";

// Toolbar title slot cap. SwiftUI Text under `<Host matchContents>` reports
// its own intrinsic size, so height is auto. Width still wants a ceiling —
// otherwise a long basename pushes the back/confirm buttons off-screen.
//
// 240pt is the OUTER cap (padded box). With 20pt horizontal padding the
// inner text content area is 200pt ≈ 25 Latin chars / 14 CJK chars at the
// 17pt system toolbar font; SwiftUI's `.frame(maxWidth:)` truncates beyond
// with native ellipsis, while shorter names content-size (no awkward
// whitespace around "Desktop").
//
// iOS-only — on Android `Host` becomes a Compose container and the modifier
// array is ignored, so long names could overflow there; we ship iOS-first
// per project_v0_distribution.
const TITLE_MAX_WIDTH = 240;

/**
 * cwd picker page — single screen reused at every folder level via the
 * `?path=…` query param. Root (no param) defaults to the daemon-reported
 * home directory.
 *
 * Toolbar layout mirrors mobile Safari's bottom UIToolbar:
 *
 *   [ ◀ back ]    [ Documents ]    [ ✓ confirm ]
 *
 * - back: `router.back()` pops one folder; disabled at root (no path param,
 *   i.e. inner stack history is empty)
 * - center: `basename(path)` wrapped in `Stack.Toolbar.View` (the
 *   primitive that accepts arbitrary RN children — `Stack.Toolbar.Label` is
 *   meant for use INSIDE a Button, not standalone)
 * - confirm: `variant="prominent"` gives the iOS 26 capsule fill; commits
 *   the current path to `lastUsedCwd` and pops the entire sheet via
 *   `router.dismissTo("/")` (POP_TO bubbles past inner stack)
 *
 * Body is the platform-aware FolderList: on iOS, swift-ui Form + Section
 * (per the workaround documented in [folder-list.ios.tsx]); on other
 * platforms, an "iOS-only" stub from `folder-list.tsx`.
 */
export default function CwdPickerScreen() {
  // `?path` undefined = root mode → render Locations + Recents lists
  // and disable confirm (no "current" path to commit). Defined path =
  // browse mode → render that folder's contents and enable confirm.
  // FolderList does the branch internally based on this prop.
  const { path } = useLocalSearchParams<{ path?: string }>();

  const setLastUsedCwd = useSetLastUsedCwd();

  const confirm = () => {
    if (!path) return;
    setLastUsedCwd.mutate(path);
    // dismissTo("/") = POP_TO targeting the (main) stack's "/" route.
    // POP_TO doesn't find it in the inner cwd-picker stack → returns
    // null → bubbles to (main) → pops cwd-picker modal screen → sheet
    // closes regardless of how many levels deep we are.
    router.dismissTo("/");
  };

  // Files-app pattern: "Locations" at root (a menu of entry points), the
  // folder basename once user has picked a specific path to browse.
  const title = path ? basename(path) : "Locations";

  return (
    <>
      {/* Host scoped tightly around Stack.Toolbar — workaround for
          https://github.com/expo/expo/issues/44493 (bottom Stack.Toolbar
          loses SF Symbol icons + onPress handlers on the second formSheet
          presentation). Wrapping only the toolbar puts its 1×1 invisible
          native side-channel view (RouterToolbarHostView, see expo-router
          toolbar/native.ios.js) into the SwiftUI tree, which is enough to
          fix the remount bug. FolderList stays a sibling and uses its
          own narrower Host inside the swift-ui Form — keeping the RN
          loading/error/empty branches OUT of any Host avoids layout
          weirdness from mixing RN views into SwiftUI's expected
          children. */}
      <Host>
        {/* Top-left Cancel — always-on per iOS HIG picker convention
            (Files save dialog / Photos picker / Mail compose). Bails out
            of the sheet from any browse depth in one tap, complementing
            the sheet grabber for VoiceOver users who can't drag. */}
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            icon="xmark"
            onPress={() => router.dismissTo("/")}
            accessibilityLabel="Close"
          />
        </Stack.Toolbar>
        <Stack.Toolbar>
          {/* All three visible toolbar items hide at root (no `?path`) —
              user is browsing Locations/Recent and there's no "current
              folder" identity worth labeling or committing. UIToolbar
              still renders its background bar; if you want the bar
              itself gone too, condition the whole <Stack.Toolbar> on
              `path !== undefined`. We don't (yet) because conditional
              mount risks reintroducing the #44493 remount bug. */}
          <Stack.Toolbar.Button
            icon="chevron.left"
            onPress={() => router.back()}
            disabled={!path}
            hidden={!path}
            accessibilityLabel="Back"
          />
          {/* Two flex Spacers (one here, one after the title View) center
              the basename between back and confirm. iOS Files-app pattern:
              current folder identity is the visual focus, actions flank
              it. Swap to a single Spacer here only if you want Safari-style
              right-flushed title hugging confirm. */}
          <Stack.Toolbar.Spacer />
          <Stack.Toolbar.View hidden={!path}>
            {/* SwiftUI Text under `<Host matchContents>` self-reports its
                intrinsic size to the UIToolbar custom-item slot, so we get
                auto-height + content-sized width for free. The `frame`
                modifier caps width at TITLE_MAX_WIDTH so a long folder name
                truncates with native ellipsis instead of pushing buttons off
                the bar. textStyle uses the @expo/ui prop shape (numeric
                fontSize + string fontWeight) — not RN style. */}
            <Host matchContents>
              <UiText
                modifiers={[
                  // SwiftUI modifier order = outside-in as written. `padding`
                  // first wraps the raw Text in 20pt horizontal breathing
                  // room; `frame` then caps the padded box at TITLE_MAX_WIDTH,
                  // so the slot reported back to UIToolbar is ≤ 240pt total
                  // (inner text content area ≤ 200pt).
                  padding({ horizontal: 20 }),
                  frame({ maxWidth: TITLE_MAX_WIDTH }),
                ]}
                textStyle={{
                  fontSize: 17,
                  fontWeight: "600",
                  textAlign: "center",
                }}
                numberOfLines={1}
              >
                {title}
              </UiText>
            </Host>
          </Stack.Toolbar.View>
          <Stack.Toolbar.Spacer />
          <Stack.Toolbar.Button
            icon="checkmark"
            variant="prominent"
            onPress={confirm}
            disabled={!path}
            hidden={!path}
            accessibilityLabel="Use this folder"
          />
        </Stack.Toolbar>
      </Host>

      <FolderList path={path} />
    </>
  );
}

/** Cheap last-segment helper. Mirrors the one in git-status-bar.tsx —
 *  inlined rather than exported to keep that file's API surface tiny.
 *  Returns "/" for the filesystem root edge case. */
function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  if (trimmed === "") return "/";
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}
