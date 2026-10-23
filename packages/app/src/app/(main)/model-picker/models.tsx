import {
  Button,
  Form,
  Host,
  HStack,
  Image,
  Section,
  Spacer,
  Text as SwiftText,
} from "@expo/ui/swift-ui";
import { font, foregroundStyle } from "@expo/ui/swift-ui/modifiers";
import type { ModelInfo } from "@thinkite/oc-client";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { pickModel, useModelChoice } from "@/hooks/use-model-choice";
import { useOcProviders } from "@/hooks/use-oc-models";
import {
  displayName,
  isFreeModel,
  modelSections,
  refOf,
} from "@/lib/model-catalog";

/**
 * The model picker's second level: the catalog by provider (opencode
 * desktop's order; the newest of each family unless searching — see
 * lib/model-catalog), with a native search bar. Tapping a model picks it
 * at its default effort and goes back to the first level, where the effort
 * can be set. Same params as the first level.
 */
export default function ModelListScreen() {
  const params = useLocalSearchParams<{
    session?: string;
    directory?: string;
  }>();
  const sessionID = params.session ?? null;
  const choice = useModelChoice(sessionID, params.directory);
  const providers = useOcProviders();
  const [query, setQuery] = useState("");
  const sections = useMemo(
    () => modelSections(choice.models, providers, choice.model, query),
    [choice.models, providers, choice.model, query],
  );

  const pick = (m: ModelInfo) => {
    const ref = refOf(m);
    if (ref !== choice.model) pickModel(sessionID, ref, "default");
    router.back();
  };

  return (
    <>
      <Stack.Screen options={{ headerTitle: "Choose Model" }} />
      <Stack.SearchBar
        placeholder="Search models"
        hideWhenScrolling={false}
        autoCapitalize="none"
        onChangeText={(e) => setQuery(e.nativeEvent.text)}
        onCancelButtonPress={() => setQuery("")}
      />
      <Host style={{ flex: 1 }}>
        <Form>
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
