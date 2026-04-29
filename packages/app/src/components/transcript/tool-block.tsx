import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { Accordion, BottomSheet, Button } from "heroui-native";
import { Text, View } from "react-native";
import {
  type ToolRenderBlock,
  summarizeToolInput,
} from "@/lib/transcript-blocks";

/**
 * One tool_use + paired tool_result. Trigger = chip + summary; expanded
 * shows pretty-printed input and a capped result preview, with a
 * "View full output" button that opens a BottomSheet with the full text.
 *
 * The BottomSheet is encapsulated here on purpose. Sheet open ⇒ overlay
 * blocks the FlatList ⇒ no virtualization unmount mid-animation, so
 * keeping per-row sheets is safe. See conversation: BottomSheet vs
 * hoisted-state for the rationale.
 */
export function ToolBlock({ block }: { block: ToolRenderBlock }) {
  const summary = summarizeToolInput(block.name, block.input);
  const inputJson = prettyJson(block.input);
  const isError = block.result?.isError === true;

  return (
    <Accordion>
      <Accordion.Item value={block.toolUseId}>
        <Accordion.Trigger className="px-4 py-3">
          <View className="flex-1 flex-row items-center gap-2">
            <ToolChip name={block.name} isError={isError} />
            {summary ? (
              <Text
                numberOfLines={1}
                className="flex-1 text-sm text-gray-700 dark:text-gray-300"
              >
                {summary}
              </Text>
            ) : (
              <View className="flex-1" />
            )}
          </View>
          <Accordion.Indicator />
        </Accordion.Trigger>
        <Accordion.Content className="px-4 pb-4">
          <SectionLabel>Input</SectionLabel>
          <Text
            selectable
            className="rounded bg-gray-100 p-2 text-xs text-gray-900 dark:bg-gray-900 dark:text-gray-100"
          >
            {inputJson}
          </Text>
          {block.result ? (
            <ResultSection
              content={block.result.content}
              isError={isError}
              toolName={block.name}
              summary={summary}
            />
          ) : (
            <Text className="mt-3 text-xs italic text-gray-500 dark:text-gray-400">
              (No result — session may be in progress)
            </Text>
          )}
        </Accordion.Content>
      </Accordion.Item>
    </Accordion>
  );
}

function ResultSection({
  content,
  isError,
  toolName,
  summary,
}: {
  content: string;
  isError: boolean;
  toolName: string;
  summary: string;
}) {
  const lines = content.split("\n");
  const isLong = lines.length > 20;
  const preview = isLong ? lines.slice(0, 20).join("\n") : content;

  return (
    <View className="mt-3">
      <SectionLabel error={isError}>
        {isError ? "Error" : "Result"}
      </SectionLabel>
      <View
        className={`rounded p-2 ${
          isError ? "bg-red-50 dark:bg-red-950" : "bg-gray-100 dark:bg-gray-900"
        }`}
      >
        <Text
          selectable
          className={`text-xs ${
            isError
              ? "text-red-900 dark:text-red-100"
              : "text-gray-900 dark:text-gray-100"
          }`}
        >
          {preview}
        </Text>
      </View>
      {isLong ? (
        <FullOutputSheet
          toolName={toolName}
          summary={summary}
          content={content}
          isError={isError}
          truncatedLines={lines.length - 20}
        />
      ) : null}
    </View>
  );
}

function FullOutputSheet({
  toolName,
  summary,
  content,
  isError,
  truncatedLines,
}: {
  toolName: string;
  summary: string;
  content: string;
  isError: boolean;
  truncatedLines: number;
}) {
  return (
    <BottomSheet>
      <BottomSheet.Trigger asChild>
        <Button variant="tertiary" size="sm" className="mt-2">
          <Button.Label>
            View full output ({truncatedLines} more line
            {truncatedLines === 1 ? "" : "s"})
          </Button.Label>
        </Button>
      </BottomSheet.Trigger>
      <BottomSheet.Portal>
        <BottomSheet.Overlay />
        <BottomSheet.Content
          snapPoints={["75%", "90%"]}
          enableOverDrag={false}
          enableDynamicSizing={false}
          contentContainerClassName="h-full px-0"
        >
          {/*
            Single BottomSheetScrollView child. Header lives inside it as
            the first item, not as a sibling — sibling layout in
            BottomSheet.Content doesn't give the scroll container a flex
            hint, so the gesture-driven scroll wouldn't engage even when
            content overflowed.
          */}
          <BottomSheetScrollView
            contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
          >
            <View className="mb-3 flex-row items-center gap-2">
              <ToolChip name={toolName} isError={isError} />
              {summary ? (
                <Text
                  numberOfLines={1}
                  className="flex-1 text-sm text-gray-700 dark:text-gray-300"
                >
                  {summary}
                </Text>
              ) : null}
            </View>
            <Text
              selectable
              className={`text-xs ${
                isError
                  ? "text-red-900 dark:text-red-100"
                  : "text-gray-900 dark:text-gray-100"
              }`}
            >
              {content}
            </Text>
          </BottomSheetScrollView>
        </BottomSheet.Content>
      </BottomSheet.Portal>
    </BottomSheet>
  );
}

function ToolChip({ name, isError }: { name: string; isError: boolean }) {
  return (
    <View
      className={`rounded-md px-2 py-0.5 ${
        isError ? "bg-red-100 dark:bg-red-900" : "bg-blue-100 dark:bg-blue-900"
      }`}
    >
      <Text
        className={`text-[11px] font-semibold uppercase tracking-wide ${
          isError
            ? "text-red-700 dark:text-red-200"
            : "text-blue-700 dark:text-blue-200"
        }`}
      >
        {name}
      </Text>
    </View>
  );
}

function SectionLabel({
  children,
  error,
}: {
  children: React.ReactNode;
  error?: boolean;
}) {
  return (
    <Text
      className={`mb-1 text-[10px] font-medium uppercase tracking-wider ${
        error
          ? "text-red-600 dark:text-red-400"
          : "text-gray-500 dark:text-gray-400"
      }`}
    >
      {children}
    </Text>
  );
}

function prettyJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
