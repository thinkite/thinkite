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
} from "@expo/ui/swift-ui/modifiers";
import { type ModelInfo, variantLabel } from "@thinkite/oc-client";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import {
  formatTokens,
  pickModel,
  useContextUsage,
  useModelChoice,
} from "@/hooks/use-model-choice";
import { useOcProviders } from "@/hooks/use-oc-models";
import {
  displayName,
  isFreeModel,
  modelSections,
  refOf,
} from "@/lib/model-catalog";

/**
 * The composer's model picker: a formSheet over the session (or the new
 * session), opened from the composer's model chip. The UIMenu it replaces
 * could not search a catalog of a hundred-odd models, and nested variant
 * submenus scrolled out of reach.
 *
 *   [×]            Model
 *   [ Search models          ]
 *   ── DeepSeek V4.1 Flash ──
 *   Effort   [Default|Low|High|Max]
 *   Context            145k / 1M
 *   ── OpenCode Zen ──
 *   Big Pickle                  ✓
 *   …
 *
 * The current model's section comes first: its effort is a segmented
 * picker (applied at once, the sheet stays) and its context use. Then the
 * catalog by provider, the newest of each family unless searching
 * (lib/model-catalog). Tapping a model picks it at its default effort and
 * closes the sheet. Picks go through `pickModel`: a session switches right
 * away; the new session's draft waits for create.
 *
 * Params: `session` (a session id), or `directory` for the new session
 * (the folder whose default model it shows until a pick).
 */
export default function ModelPickerScreen() {
  const { session, directory } = useLocalSearchParams<{
    session?: string;
    directory?: string;
  }>();
  const sessionID = session ?? null;
  const choice = useModelChoice(sessionID, directory);
  const providers = useOcProviders();
  const usage = useContextUsage(sessionID, choice.info?.limit.context);
  const [query, setQuery] = useState("");
  const sections = useMemo(
    () => modelSections(choice.models, providers, choice.model, query),
    [choice.models, providers, choice.model, query],
  );
  const variants = choice.info?.variants.map((v) => v.id) ?? [];

  const pick = (m: ModelInfo) => {
    const ref = refOf(m);
    if (ref !== choice.model) pickModel(sessionID, ref, "default");
    router.back();
  };

  return (
    <>
      <Stack.SearchBar
        placeholder="Search models"
        hideWhenScrolling={false}
        autoCapitalize="none"
        onChangeText={(e) => setQuery(e.nativeEvent.text)}
        onCancelButtonPress={() => setQuery("")}
      />
      {/* Host scoped to the toolbar: the expo/expo#44493 workaround the
          cwd picker documents (a sheet's toolbar loses its handlers on a
          second presentation otherwise). */}
      <Host>
        <Stack.Toolbar placement="left">
          <Stack.Toolbar.Button
            icon="xmark"
            onPress={() => router.back()}
            accessibilityLabel="Close"
          />
        </Stack.Toolbar>
      </Host>
      <Host style={{ flex: 1 }}>
        <Form>
          {choice.info !== undefined &&
          query === "" &&
          (variants.length > 0 || usage !== undefined) ? (
            <Section title={displayName(choice.info)}>
              {variants.length > 0 ? (
                <Picker
                  label="Effort"
                  selection={choice.variant}
                  onSelectionChange={(v: string) => {
                    if (choice.model !== null && v !== choice.variant)
                      pickModel(sessionID, choice.model, v);
                  }}
                  modifiers={[pickerStyle("segmented")]}
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
          ) : null}
          {sections.map((s) => (
            <Section key={s.providerID} title={s.title}>
              {s.models.map((m) => (
                <ModelRow
                  key={refOf(m)}
                  model={m}
                  isCurrent={refOf(m) === choice.model}
                  onPress={() => pick(m)}
                />
              ))}
            </Section>
          ))}
        </Form>
      </Host>
    </>
  );
}

/** A model: its name, "Free" for opencode's free ones, a check on the
 *  current one. A bare swift-ui Button so the Form styles it as a list row
 *  (see folder-list.ios.tsx on why not the universal Button). */
function ModelRow({
  model,
  isCurrent,
  onPress,
}: {
  model: ModelInfo;
  isCurrent: boolean;
  onPress: () => void;
}) {
  return (
    <Button onPress={onPress}>
      <HStack alignment="center" spacing={8}>
        <SwiftText modifiers={[foregroundStyle("primary")]}>
          {displayName(model)}
        </SwiftText>
        <Spacer />
        {isFreeModel(model) ? (
          <SwiftText
            modifiers={[
              font({ textStyle: "footnote" }),
              foregroundStyle("secondary"),
            ]}
          >
            Free
          </SwiftText>
        ) : null}
        {isCurrent ? <Image systemName="checkmark" size={15} /> : null}
      </HStack>
    </Button>
  );
}
