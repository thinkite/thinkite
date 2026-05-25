import { MenuView } from "@expo/ui/community/menu";
import { SymbolView } from "expo-symbols";
import { Pressable, useColorScheme } from "react-native";
import { MenuTestScreen } from "@/components/dev/menu-test-screen";

/**
 * Dev probe — same chrome as dev/menu-rnm.tsx but the `+` button uses
 * `@expo/ui/community/menu` (SwiftUI Menu wrapped in UIHostingController).
 *
 * Expected bug on iOS 14+ system IME: first time keyboard opens, the
 * `+` trigger lands a few points HIGHER than the sibling mic Pressable.
 * Switching IMEs (English ↔ Pinyin, or to WeChat and back) realigns
 * it. Root cause is UIHostingController's auto keyboard avoidance
 * stacking onto the parent KSV's translate.
 */
export default function ExpoMenuTestScreen() {
  const colorScheme = useColorScheme() ?? "light";
  const tint = colorScheme === "dark" ? "#e4e4e7" : "#3f3f46";

  return (
    <MenuTestScreen
      title="Menu Test — @expo/ui"
      menuButton={
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
            /* no-op — this route exists only to test trigger alignment,
               not to actually pick images. */
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
