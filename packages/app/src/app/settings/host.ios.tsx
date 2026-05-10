import {
  Button,
  Form,
  Host,
  HStack,
  Image,
  Section,
  Text,
} from "@expo/ui/swift-ui";
import { font } from "@expo/ui/swift-ui/modifiers";
import { Stack } from "expo-router";
import { Alert } from "react-native";
import {
  statusColor,
  statusLabel,
  useDaemonClient,
} from "@/lib/daemon-client-context";

/**
 * Single-host detail page, iOS-only. See settings/index.ios.tsx for why
 * this lives in the SwiftUI namespace instead of the universal API.
 *
 * V0 is single-paired-daemon, so the route has no dynamic segment.
 * "Forget host" calls `unpair()` which closes the WS, wipes SecureStore,
 * and flips state to `unpaired` — the root Stack.Protected guard then
 * routes back to /pair automatically (no imperative router call needed).
 *
 * Destructive action uses `<Button role="destructive" label="...">` —
 * SwiftUI gives us systemRed (auto light/dark adapt), red-tinted cell
 * highlight on press, and a "destructive" VoiceOver hint, all native.
 *
 * If/when multi-host arrives, rename to `hosts/[fingerprint].ios.tsx`
 * and source the record by id; the section structure carries over.
 */
export default function SettingsHostScreen() {
  const { paired, unpair, connectionStatus } = useDaemonClient();

  const onForget = () => {
    Alert.alert(
      "Forget this host?",
      "You'll need to scan the QR from `sidecode pair` again to reconnect.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Forget",
          style: "destructive",
          onPress: () => {
            void unpair();
          },
        },
      ],
    );
  };

  const addresses = paired?.addresses.join("\n") ?? "—";

  return (
    <>
      <Stack.Screen options={{ title: paired?.serviceName ?? "Host" }} />
      <Host style={{ flex: 1 }}>
        <Form>
          <Section title="Status">
            <HStack alignment="center" spacing={8}>
              <Image
                systemName="circle.fill"
                size={10}
                color={statusColor(connectionStatus)}
              />
              <Text>{statusLabel(connectionStatus)}</Text>
            </HStack>
          </Section>
          <Section title="Hostname">
            <Text>{paired?.serviceName ?? "—"}</Text>
          </Section>
          <Section title="Fingerprint">
            <Text modifiers={[font({ design: "monospaced" })]}>
              {paired?.fingerprint ?? "—"}
            </Text>
          </Section>
          <Section title="Addresses">
            <Text modifiers={[font({ design: "monospaced" })]}>
              {addresses}
            </Text>
          </Section>
          <Section>
            {/* biome-ignore lint/a11y/useValidAriaRole: SwiftUI ButtonRole
                ('default' | 'cancel' | 'destructive'), not an HTML/ARIA
                role attribute. Drives systemRed + VoiceOver "destructive"
                hint at the SwiftUI layer. */}
            <Button role="destructive" label="Forget host" onPress={onForget} />
          </Section>
        </Form>
      </Host>
    </>
  );
}
