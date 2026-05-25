import {
  Button,
  Form,
  Host,
  HStack,
  Image,
  Section,
  Spacer,
  Text,
} from "@expo/ui/swift-ui";
import { foregroundStyle } from "@expo/ui/swift-ui/modifiers";
import { router, Stack } from "expo-router";
import { statusColor, useDaemonClient } from "@/lib/daemon-client-context";

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
  const { paired, connectionStatus } = useDaemonClient();
  return (
    <>
      <Stack.Screen options={{ title: "Settings" }} />
      {/* Top-left Cancel — iOS HIG: dismiss/back actions on the leading
          edge. Settings was historically on the right; aligned with
          cwd-picker + pair for a single consistent sheet-dismiss
          location across the app. */}
      <Stack.Toolbar placement="left">
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
                {/* Leading status dot (Mail.app unread-indicator pattern) —
                    scannable at-a-glance state without reading text. Same
                    color as the host-detail Status section so the row's
                    state matches the page it leads to. */}
                <Image
                  systemName="circle.fill"
                  size={10}
                  color={statusColor(connectionStatus)}
                />
                {/* Without an explicit foreground style, SwiftUI Button
                    tints the title text with the current accent color
                    (system blue). `foregroundStyle("primary")` forces
                    the literal `Color.primary` (black/white auto-adapt). */}
                <Text modifiers={[foregroundStyle("primary")]}>
                  {paired?.serviceName ?? "—"}
                </Text>
                <Spacer />
                <Image systemName="chevron.right" size={14} color="#8E8E93" />
              </HStack>
            </Button>
          </Section>
        </Form>
      </Host>
    </>
  );
}
