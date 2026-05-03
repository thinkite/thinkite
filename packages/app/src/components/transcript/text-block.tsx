import { Text, View } from "react-native";
import { MarkdownView } from "@/lib/markdown";
import type { TextRenderBlock } from "@/lib/transcript-blocks";

const ROLE_LABEL: Record<TextRenderBlock["role"], string> = {
  user: "YOU",
  assistant: "CLAUDE",
};

/**
 * One text block (a single ContentBlock from the transcript) rendered
 * top-down, full-width — reading-mode, not chat-mode. User text is plain;
 * assistant text goes through MarkdownView (Apple MarkdownView via Nitro)
 * so code blocks, lists, tables, links, diff blocks render natively with
 * tree-sitter syntax highlighting and stay at 60fps under streaming.
 *
 * Follow-up blocks of the same role (`isFirstOfRoleRun: false`) drop the
 * role header and top border so a multi-message assistant turn reads as
 * one continuous response. flattenToBlocks computes the flag.
 */
export function TextBlock({ block }: { block: TextRenderBlock }) {
  const continued = !block.isFirstOfRoleRun;
  return (
    <View
      className={
        continued
          ? "px-4 pb-3"
          : "border-t border-gray-200 px-4 py-3 dark:border-gray-800"
      }
    >
      {continued ? null : (
        <Text className="mb-1 text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {ROLE_LABEL[block.role]}
        </Text>
      )}
      {block.role === "assistant" ? (
        <MarkdownView content={block.text} />
      ) : (
        <Text selectable className="text-base text-black dark:text-white">
          {block.text}
        </Text>
      )}
    </View>
  );
}
