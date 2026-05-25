import { MenuView } from "@react-native-menu/menu";
import { SymbolView } from "expo-symbols";
import { Pressable, useColorScheme } from "react-native";
import { MenuTestScreen } from "@/components/dev/menu-test-screen";

/**
 * Dev probe — same chrome as dev/menu-expo.tsx but the `+` button uses
 * `@react-native-menu/menu` (UIKit UIMenu, no UIHostingController).
 *
 * Expected: `+` stays aligned with mic on first system-IME keyboard
 * show — no UIHostingController auto-avoidance to fight with KSV's
 * translate. If `+` still misaligns here, the bug is elsewhere (KSV,
 * the surrounding layout, etc.) and not the menu library.
 *
 * `imageColor` is explicitly set per react-native-menu/menu#1198 —
 * SDK 55+ New Arch forwards a default `0` tint that renders SF Symbols
 * as opaque-zero (invisible) without an explicit value.
 */
export default function RnmMenuTestScreen() {
  const colorScheme = useColorScheme() ?? "light";
  const tint = colorScheme === "dark" ? "#e4e4e7" : "#3f3f46";

  return (
    <MenuTestScreen
      title="Menu Test — @react-native-menu"
      menuButton={
        <MenuView
          actions={[
            {
              id: "library",
              title: "Photos",
              image: "photo.on.rectangle",
              imageColor: tint,
            },
            {
              id: "camera",
              title: "Camera",
              image: "camera",
              imageColor: tint,
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
      }
    />
  );
}
