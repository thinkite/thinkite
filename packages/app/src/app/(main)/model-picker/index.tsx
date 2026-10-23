import {
  Button,
  Form,
  Host,
  HStack,
  Image,
  LabeledContent,
  Picker,
  Section,
  Spacer,
  Text as SwiftText,
} from "@expo/ui/swift-ui";
import {
  font,
  foregroundStyle,
  pickerStyle,
  tag,
  tint,
} from "@expo/ui/swift-ui/modifiers";
import { variantLabel } from "@thinkite/oc-client";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { PlatformColor } from "react-native";
import {
  formatTokens,
  pickModel,
  useContextUsage,
  useModelChoice,
} from "@/hooks/use-model-choice";
import { displayName } from "@/lib/model-catalog";

/**
 * The composer's model picker, first level: what the composer runs on, as
 * Settings-style rows. A formSheet over the session (or the new session),
 * opened from the composer's model chip.
 *
 *   [×]            Model
 *   Model     DeepSeek V4.1 Flash ›    → models.tsx (search, by provider)
 *   Effort                  High ⌃⌄    a menu picker, applied at once
 *   Context              461k / 1M
 *
 * Effort is the row people change most, so it sits here rather than behind
 * the model list; it shows only for a model that lists variants. Picking
 * a model on the next page comes back here with effort at Default. Picks
 * go through `pickModel` (hooks/use-model-choice): a session switches right
 * away; the new session's draft waits for create.
 *
 * Params: `session` (a session id), or `directory` for the new session
 * (the folder whose default model it shows until a pick). The model list
 * gets the same.
 */
export default function ModelPickerScreen() {
  const params = useLocalSearchParams<{
    session?: string;
    directory?: string;
  }>();
  const sessionID = params.session ?? null;
  const choice = useModelChoice(sessionID, params.directory);
  const usage = useContextUsage(sessionID, choice.info?.limit.context);
  const variants = choice.info?.variants.map((v) => v.id) ?? [];

  return (
    <>
      {/* Host scoped to the toolbar: the expo/expo#44493 workaround the
          cwd picker documents (a sheet's toolbar loses its handlers on a
          second presentation otherwise). */}
      <Host>
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            icon="xmark"
            // The sheet's first page: back closes it. (Not dismissTo("/")
            // as in the cwd picker — from a session, "/" is the new one.)
            onPress={() => router.back()}
            accessibilityLabel="Close"
          />
        </Stack.Toolbar>
      </Host>
      <Host style={{ flex: 1 }}>
        <Form>
          <Section>
            {/* A bare swift-ui Button so the Form styles it as a list row
                (see folder-list.ios.tsx on why not the universal Button). */}
            <Button
              onPress={() =>
                router.push({ pathname: "/model-picker/models", params })
              }
            >
              <HStack alignment="center" spacing={8}>
                <SwiftText modifiers={[foregroundStyle("primary")]}>
                  Model
                </SwiftText>
                <Spacer />
                <SwiftText modifiers={[foregroundStyle("secondary")]}>
                  {choice.info !== undefined
                    ? displayName(choice.info)
                    : (choice.model ?? "")}
                </SwiftText>
                {/* A color of its own: a Button tints its image with the
                    accent, and a navigation row's chevron is gray. */}
                <Image
                  systemName="chevron.right"
                  size={13}
                  color={PlatformColor("tertiaryLabel")}
                  modifiers={[font({ weight: "semibold" })]}
                />
              </HStack>
            </Button>
            {variants.length > 0 ? (
              <Picker
                label="Effort"
                selection={choice.variant}
                onSelectionChange={(v: string) => {
                  if (choice.model !== null && v !== choice.variant)
                    pickModel(sessionID, choice.model, v);
                }}
                // Gray like Settings' menu rows; SwiftUI tints a menu
                // picker's value and chevrons with the accent by default.
                modifiers={[pickerStyle("menu"), tint("secondary")]}
              >
                {["default", ...variants].map((v) => (
                  <SwiftText key={v} modifiers={[tag(v)]}>
                    {variantLabel(v)}
                  </SwiftText>
                ))}
              </Picker>
            ) : null}
            {usage !== undefined ? (
              <LabeledContent label="Context">
                <SwiftText modifiers={[foregroundStyle("secondary")]}>
                  {`${formatTokens(usage.used)} / ${formatTokens(usage.max)}`}
                </SwiftText>
              </LabeledContent>
            ) : null}
          </Section>
        </Form>
      </Host>
    </>
  );
}
