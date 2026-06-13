import { Pressable, Text } from "react-native";
import { toolVerb } from "@/lib/tool-verbs";
import type { ToolRenderBlock } from "@/lib/transcript-blocks";
import { useToolCallSheet } from "./tool-call-sheet";

/**
 * Trigger row for a paired tool_use+tool_result. Tap → opens the shared
 * ToolCallSheet (Paseo pattern). Inline preview was dropped along with the
 * per-row Accordion + per-row BottomSheet — all diff rendering moved into the
 * single shared sheet, so the virtualized list rows are uniform Pressables
 * that LegendList can recycle freely.
 *
 * Two specific bugs went away with the move:
 *   1. With LegendList virtualization, an inline-expanded accordion's open
 *      state was lost on scroll-out → fresh remount as collapsed. The sheet
 *      lives outside the virtualized list, so its open state is independent
 *      of row mount lifecycle.
 *   2. A per-row renderer remounting (the old inline-expand path) shifted
 *      neighboring rows during its measure pass. The sheet hosts ONE resident
 *      renderer (the Pierre webview) opened on demand — no per-row mounting,
 *      no virtualization pressure, no jitter.
 *
 * Row format = `<verb> <summary>` (claude.ai/code vocabulary, see
 * tool-verbs.ts): muted past-tense verb + darker object, red verb on
 * failure. Replaced the former uppercase tool-name chip (ToolChip) —
 * Bash rows already rendered this way ("Ran <description>"); this is
 * that pattern generalized to every tool.
 */
export function ToolBlock({ block }: { block: ToolRenderBlock }) {
  const { openToolCall } = useToolCallSheet();
  const isError = block.status === "failed";

  return (
    <Pressable onPress={() => openToolCall(block)} className="px-4 py-1.5">
      <Text
        numberOfLines={1}
        className="text-base text-gray-700 dark:text-gray-300"
      >
        <Text
          className={
            isError
              ? "text-red-600 dark:text-red-400"
              : "text-gray-500 dark:text-gray-400"
          }
        >
          {toolVerb(block.detail)}
        </Text>
        {block.summary ? ` ${block.summary}` : ""}
      </Text>
    </Pressable>
  );
}
