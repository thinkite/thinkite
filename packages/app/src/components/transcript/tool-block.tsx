import { Pressable, Text, View } from "react-native";
import type { ToolRenderBlock } from "@/lib/transcript-blocks";
import { ToolChip, useToolCallSheet } from "./tool-call-sheet";

/**
 * Trigger row for a paired tool_use+tool_result. Tap → opens the shared
 * ToolCallSheet (Paseo pattern). Inline preview was dropped along with the
 * per-row Accordion + per-row BottomSheet — all DiffsView mounting moved to
 * the sheet, so the virtualized list rows are uniform Pressables that
 * LegendList can recycle freely.
 *
 * Two specific bugs went away with the move:
 *   1. With LegendList virtualization, an inline-expanded accordion's open
 *      state was lost on scroll-out → fresh remount as collapsed. The sheet
 *      lives outside the virtualized list, so its open state is independent
 *      of row mount lifecycle.
 *   2. DiffsView (Nitro hybrid view) can't self-size synchronously
 *      (mrousavy/nitro#1199); when an inline expanded row remounted, the
 *      0→real height transition shifted neighboring rows. The sheet only
 *      mounts DiffsView when opened — no virtualization pressure, single
 *      measurement, no jitter.
 *
 * Bash gets a chip-less "Ran <description>" verb-led header to match
 * Claude Desktop. Other tools render `<chip> <summary>`.
 */
export function ToolBlock({ block }: { block: ToolRenderBlock }) {
  const { openToolCall } = useToolCallSheet();
  const isError = block.status === "failed";
  const isBash = block.name === "Bash";

  return (
    <Pressable
      onPress={() => openToolCall(block)}
      className="flex-row items-center gap-2 px-4 py-3"
    >
      {isBash ? (
        <Text
          numberOfLines={1}
          className="flex-1 text-sm text-gray-700 dark:text-gray-300"
        >
          <Text
            className={
              isError
                ? "text-red-600 dark:text-red-400"
                : "text-gray-500 dark:text-gray-400"
            }
          >
            Ran{" "}
          </Text>
          {block.summary}
        </Text>
      ) : (
        <>
          <ToolChip name={block.name} isError={isError} />
          {block.summary ? (
            <Text
              numberOfLines={1}
              className="flex-1 text-sm text-gray-700 dark:text-gray-300"
            >
              {block.summary}
            </Text>
          ) : (
            <View className="flex-1" />
          )}
        </>
      )}
    </Pressable>
  );
}
