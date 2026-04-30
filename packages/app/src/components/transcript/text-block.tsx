import {
  EnrichedMarkdownText,
  type MarkdownStyle,
} from "react-native-enriched-markdown";
import { Text, View } from "react-native";
import type { TextRenderBlock } from "@/lib/transcript-blocks";

const ROLE_LABEL: Record<TextRenderBlock["role"], string> = {
  user: "YOU",
  assistant: "CLAUDE",
};

/**
 * One text block (a single ContentBlock from the transcript) rendered
 * top-down, full-width — reading-mode, not chat-mode. User text is plain;
 * assistant text goes through EnrichedMarkdownText so code blocks, lists,
 * links, etc. render natively.
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
        <EnrichedMarkdownText
          markdown={block.text}
          selectable
          markdownStyle={MARKDOWN_STYLE}
        />
      ) : (
        <Text selectable className="text-base text-black dark:text-white">
          {block.text}
        </Text>
      )}
    </View>
  );
}

// Light tweaks against the lib's defaults — let it own typography otherwise.
// Dark mode is deferred until we have a theme context to feed the style obj.
const MARKDOWN_STYLE: MarkdownStyle = {
  paragraph: { color: "#000", fontSize: 16, lineHeight: 22 },
  code: { backgroundColor: "#f3f4f6", color: "#111", fontSize: 14 },
  codeBlock: {
    backgroundColor: "#f3f4f6",
    color: "#111",
    fontSize: 13,
    padding: 8,
    borderRadius: 4,
  },
};
