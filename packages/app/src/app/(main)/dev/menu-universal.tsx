import { MenuView } from "@expo/ui/community/menu";
import { Host } from "@expo/ui/swift-ui";
import { SymbolView } from "expo-symbols";
import { Pressable, useColorScheme } from "react-native";
import { MenuTestScreen } from "@/components/dev/menu-test-screen";

/**
 * Dev probe — same chrome as the other dev/menu-* routes, but the `+`
 * button uses the "Universal" `MenuView` from `@expo/ui/community/menu`
 * (the cross-platform drop-in replacement for `@react-native-menu/menu`).
 *
 * This route exists to A/B-test: does wrapping community/menu's
 * MenuView in `<Host ignoreSafeArea="keyboard">` transfer the fix that
 * works for swift-ui/Menu (dev/menu-expo)?
 *
 * Likely answer NO: community/menu instantiates its OWN internal
 * UIHostingController to render the SwiftUI Menu. The outer Host's
 * `ignoreSafeArea` prop configures the OUTER HC's safeArea, but the
 * inner HC is a separate UIView Apple-side and isn't touched. If that's
 * right, the `+` button will still drift up on first keyboard show.
 *
 * Empirical: see what actually happens — if community/menu's inner HC
 * does inherit safeArea config from its parent UIView hierarchy
 * (unlikely but worth confirming), the fix would transfer and we could
 * collapse back to one menu library.
 */
export default function UniversalMenuTestScreen() {
  const colorScheme = useColorScheme() ?? "light";
  const tint = colorScheme === "dark" ? "#e4e4e7" : "#3f3f46";

  return (
    <MenuTestScreen
      title="Menu Test — @expo/ui Universal"
      menuButton={
        <Host matchContents ignoreSafeArea="keyboard">
          <MenuView
            actions={[
              {
                id: "library",
                title: "Photos",
                image: "photo.on.rectangle",
              },
              {
                id: "camera",
                title: "Camera",
                image: "camera",
              },
            ]}
            onPressAction={() => {
              /* no-op — alignment probe only. */
            }}
          >
            <Pressable className="p-1.75">
              <SymbolView
                name="plus"
                size={22}
                weight="regular"
                tintColor={tint}
              />
            </Pressable>
          </MenuView>
        </Host>
      }
    />
  );
}
