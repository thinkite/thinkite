import { Text, View } from "react-native";
import { ImageStack } from "@/components/image-stack";
import { materializeImagesSync } from "@/lib/image-cache";
import { ChunkedMarkdown } from "@/lib/markdown";
import type { TextRenderBlock } from "@/lib/transcript-blocks";

/**
 * Chat-mode rendering: user messages get a right-aligned blue bubble
 * (~85% max width — the parent transcript container already provides
 * outer horizontal padding, so the bubble can use most of the inner
 * column). Assistant messages stream as full-width markdown via
 * `ChunkedMarkdown` — text/table runs still go through enriched (Fabric,
 * Yoga-self-sizing, so rows hit LegendList with real height on first
 * layout), while code blocks break out into shiki-highlighted native
 * Text. See `chunked-markdown.tsx` header for the design.
 *
 * `streaming` comes from ChatPanel's derivation (last block && assistant
 * && turn running — there is no protocol-level settle signal; daemon
 * ignores content_block_stop). It gates three things downstream: tail-run
 * remend repair, EOF fence-close marking, and — performance-critical —
 * enriched's streamingAnimation, which must be FALSE for settled messages
 * (measurement cache) and TRUE only for actively-changing content (see
 * ChatMarkdownProps.streaming).
 *
 * Bubble shape mirrors Claude Desktop's user-message look — pale blue
 * background, dark navy text. Role labels (YOU / CLAUDE) are
 * deliberately dropped — alignment + bubble styling carry the speaker
 * signal, matching mainstream chat-app convention.
 *
 * Image attachments (user messages only) render as a right-aligned
 * `<ImageStack>` ABOVE the text bubble — iMessage-style "image
 * floats above the caption". Image-only messages (no caption) skip
 * the blue bubble entirely; text-only messages skip the stack. Both
 * paths share the outer `items-end` so alignment stays consistent.
 */
export function TextBlock({
  block,
  streaming = false,
}: {
  block: TextRenderBlock;
  streaming?: boolean;
}) {
  if (block.role === "user") {
    // Materialize base64 → file:// URIs inline. Sync (new
    // expo-file-system API), cache-hit fast path on re-render so this
    // is cheap even if TextBlock re-renders frequently. See
    // image-cache.ts header for why file:// URIs are required (Galeria
    // SDWebImage doesn't decode data: URIs).
    const fileUris =
      block.images && block.images.length > 0
        ? materializeImagesSync(block.images)
        : undefined;
    const hasText = block.text.length > 0;
    return (
      <View className="px-4 py-2.5 items-end gap-2">
        {fileUris && <ImageStack urls={fileUris} />}
        {hasText && (
          <View className="max-w-[85%] rounded-xl bg-[#0A0A0A0F] dark:bg-[#FAFAFA14] px-3 py-2">
            <Text
              selectable
              className="text-base text-[#0A0A0A] dark:text-[#FAFAFA]"
            >
              {block.text}
            </Text>
          </View>
        )}
      </View>
    );
  }
  return (
    <View className="px-4 py-1.5">
      <ChunkedMarkdown markdown={block.text} streamDone={!streaming} />
    </View>
  );
}
