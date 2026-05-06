import { Text, View } from "react-native";
import { ChatMarkdown } from "@/lib/markdown";
import type { TextRenderBlock } from "@/lib/transcript-blocks";

/**
 * Chat-mode rendering: user messages get a right-aligned blue bubble
 * (~85% max width — the parent transcript container already provides
 * outer horizontal padding, so the bubble can use most of the inner
 * column). Assistant messages stream as full-width markdown via
 * `ChatMarkdown` (react-native-enriched-markdown) — Fabric component
 * that self-sizes via Yoga, so each row hits LegendList with its real
 * height on first layout. Avoids the Nitro async-measurement flicker
 * that DiffsView (used in tool-block) suffers from. See
 * `ChatMarkdown.tsx` header for the full chat-vs-tool-detail rationale.
 *
 * Bubble shape mirrors Claude Desktop's user-message look — pale blue
 * background, dark navy text. Role labels (YOU / CLAUDE) are
 * deliberately dropped — alignment + bubble styling carry the speaker
 * signal, matching mainstream chat-app convention.
 */
export function TextBlock({ block }: { block: TextRenderBlock }) {
  if (block.role === "user") {
    return (
      <View className="px-4 py-2">
        <View className="max-w-[85%] self-end rounded-xl bg-blue-100 px-3 py-2">
          <Text selectable className="text-base leading-5.5 text-blue-900">
            {block.text}
          </Text>
        </View>
      </View>
    );
  }
  return (
    <View className="px-4 py-2">
      <ChatMarkdown markdown={block.text} />
    </View>
  );
}
