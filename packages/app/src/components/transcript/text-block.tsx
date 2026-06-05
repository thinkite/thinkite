import { Text, View } from "react-native";
import { ImageStack } from "@/components/image-stack";
import { materializeImagesSync } from "@/lib/image-cache";
import { ChatMarkdown } from "@/lib/markdown";
import type { TextRenderBlock } from "@/lib/transcript-blocks";

/**
 * Chat-mode rendering: user messages get a right-aligned blue bubble
 * (~85% max width — the parent transcript container already provides
 * outer horizontal padding, so the bubble can use most of the inner
 * column). Assistant messages stream as full-width markdown via
 * `ChatMarkdown` (react-native-enriched-markdown) — Fabric component
 * that self-sizes via Yoga, so each row hits LegendList with its real
 * height on first layout. Avoids the async-measurement flicker a Nitro /
 * WebView renderer would have. See `ChatMarkdown.tsx` header for the full
 * chat-vs-tool-detail rationale.
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
export function TextBlock({ block }: { block: TextRenderBlock }) {
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
          <View className="max-w-[85%] rounded-xl bg-[#EDF5FD] px-3 py-2">
            <Text selectable className="text-base text-[#0066CC]">
              {block.text}
            </Text>
          </View>
        )}
      </View>
    );
  }
  return (
    <View className="px-4 py-1.5">
      <ChatMarkdown markdown={block.text} />
    </View>
  );
}
