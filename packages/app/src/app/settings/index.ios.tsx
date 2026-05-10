import {
  Button,
  Form,
  HStack,
  Host,
  Image,
  Section,
  Spacer,
  Text,
  VStack,
} from "@expo/ui/swift-ui";
import { font, foregroundStyle } from "@expo/ui/swift-ui/modifiers";
import { router, Stack } from "expo-router";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Settings root, iOS-only. Uses `@expo/ui/swift-ui` (Form, Section, Button +
 * custom label) directly instead of the universal API.
 *
 * Why not universal: universal Button on iOS always pushes a `buttonStyle()`
 * modifier (even for `variant="text"` → `buttonStyle("plain")`), which
 * overrides the Form-aware automatic style SwiftUI would otherwise pick.
 * Tested empirically: gives a chunky filled capsule for the destructive
 * action when we want a borderless Settings-style row. Going to swift-ui
 * namespace lets us hand the Button to Form raw and let the iOS list-style
 * inheritance kick in.
 *
 * Disclosure rows use `<Button>` with custom HStack label so SwiftUI's
 * Form/List provides cell highlight on tap for free, and full-row hit
 * area without needing `contentShape`. Inside Form, the auto-borderless
 * Button preserves children foreground colors (title primary, subtitle
 * gray, chevron gray).
 *
 * `index.tsx` is an Android stub that returns null — V0 is iOS-only.
 * The stub exists solely so expo-router's typed-routes generator picks
 * up `/settings` (it scans bare-extension files only, no platform suffix).
 */
export default function SettingsIndexScreen() {
  const { paired } = useDaemonClient();
  return (
    <>
      <Stack.Screen options={{ title: "Settings" }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon="xmark"
          accessibilityLabel="Close"
          onPress={() => router.back()}
        />
      </Stack.Toolbar>
      <Host style={{ flex: 1 }}>
        <Form>
          <Section title="Host">
            <Button onPress={() => router.push("/settings/host")}>
              <HStack alignment="center" spacing={8}>
                <VStack alignment="leading">
                  {/* Without an explicit foreground style, SwiftUI Button
                      tints the title text with the current accent color
                      (system blue). `foregroundStyle("primary")` forces
                      the literal `Color.primary` (black/white auto-adapt). */}
                  <Text modifiers={[foregroundStyle("primary")]}>
                    {paired?.serviceName ?? "—"}
                  </Text>
                  {paired ? (
                    <Text
                      modifiers={[
                        font({ size: 12 }),
                        // Hex (not `foregroundStyle("secondary")`) — SwiftUI's
                        // `.secondary` is hierarchical: it picks the secondary
                        // level of the current foreground style. Inside a
                        // Button (which has a tint), that's 60% opacity of
                        // accent color = light blue, NOT the system gray
                        // secondary-label we want. Same gotcha hits the
                        // chevron Image below.
                        foregroundStyle("#8E8E93"),
                      ]}
                    >
                      {paired.fingerprint.slice(0, 8)}
                    </Text>
                  ) : null}
                </VStack>
                <Spacer />
                <Image
                  systemName="chevron.right"
                  size={14}
                  color="#8E8E93"
                />
              </HStack>
            </Button>
          </Section>
        </Form>
      </Host>
    </>
  );
}
