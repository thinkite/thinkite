import { Button, Host, Image, Menu } from "@expo/ui/swift-ui";
import { useColorScheme } from "react-native";
import { MenuTestScreen } from "@/components/dev/menu-test-screen";

/**
 * Dev probe — same chrome as dev/menu-rnm.tsx but the `+` button uses
 * the SwiftUI-native `Menu` from `@expo/ui/swift-ui`.
 *
 * Drift bug we chased: first time the keyboard opens, `+` lands a few
 * points HIGHER than the sibling mic Pressable; switching IMEs
 * realigns. Fix: set `ignoreSafeArea="keyboard"` on the surrounding
 * `<Host>` — this is a Host PROP, not the SwiftUI modifier of the same
 * name. Per Expo docs the prop "Controls which safe area regions the
 * SwiftUI hosting view should ignore. Can only be set once on mount."
 * i.e. it configures the UIHostingController's UIView-layer
 * safeAreaInsets directly, not the SwiftUI-layer ignoresSafeArea
 * modifier (which we proved doesn't reach the HC).
 *
 * What didn't work (kept here so we don't re-try):
 *   - `.ignoresSafeArea(.keyboard)` SwiftUI modifier on Menu / Image
 *     → SwiftUI-internal layout only, HC's UIView safeArea ignores it
 *   - Wrapping community/menu's MenuView in `<Host>` with the same
 *     prop → community/menu has its OWN inner HC, outer Host's prop
 *     doesn't propagate (see dev/menu-universal route for that test)
 *   - Fixed `style={{ width: 36, height: 36 }}` on Host → frame was
 *     correct already; the drift is HC pushing its SwiftUI content UP
 *     within the frame, not the frame moving
 */
export default function ExpoMenuTestScreen() {
  const colorScheme = useColorScheme() ?? "light";
  const tint = colorScheme === "dark" ? "#e4e4e7" : "#3f3f46";

  return (
    <MenuTestScreen
      title="Menu Test — @expo/ui swift-ui"
      menuButton={
        <Host matchContents ignoreSafeArea="keyboard">
          <Menu label={<Image systemName="plus" size={22} color={tint} />}>
            <Button
              label="Photos"
              systemImage="photo.on.rectangle"
              onPress={() => {
                /* no-op — alignment probe only. */
              }}
            />
            <Button
              label="Camera"
              systemImage="camera"
              onPress={() => {
                /* no-op — alignment probe only. */
              }}
            />
          </Menu>
        </Host>
      }
    />
  );
}
