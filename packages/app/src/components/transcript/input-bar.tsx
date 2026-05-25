import { MenuView } from "@react-native-menu/menu";
import type { ImageAttachment } from "@sidecodeapp/protocol";
import { GlassView } from "expo-glass-effect";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { SymbolView } from "expo-symbols";
import { useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { Image } from "@/lib/styled";

/**
 * Local-only id so the pill row can have stable React keys + a cheap
 * remove path; never sent to the daemon (protocol's ImageAttachment
 * is just {data, mediaType}). Generated with a monotonic counter so we
 * don't pull in a UUID lib for what's effectively a render hint.
 */
interface DraftAttachment extends ImageAttachment {
  id: string;
}

/** Compose Anthropic Claude 4.x's vision input cap: long edge 2576px,
 *  ≤3.75MP. We resize the long edge then let JPEG q0.85 do the bytes
 *  work; SDK accepts base64 inline so daemon writes nothing to disk. */
const MAX_LONG_EDGE = 2576;
const JPEG_QUALITY = 0.85;
/** Total draft attachment cap per message. 8 = Opus 4.7 high-res
 *  budget headroom (4K tok/image × 8 = 32K of a 200K window) +
 *  matches PHPicker's single-pick max so users hit the cap in one
 *  Photos tap, not by re-tapping `+` repeatedly. Tune in one spot. */
const MAX_TOTAL_IMAGES = 8;

async function compressToAttachment(
  uri: string,
  width: number,
  height: number,
): Promise<ImageAttachment> {
  // Resize only when needed — sub-2576px shots skip the manipulator
  // round-trip entirely. Supplying just one of width/height preserves
  // aspect ratio automatically.
  const needsResize = Math.max(width, height) > MAX_LONG_EDGE;
  const actions = needsResize
    ? [
        width >= height
          ? { resize: { width: MAX_LONG_EDGE } }
          : { resize: { height: MAX_LONG_EDGE } },
      ]
    : [];
  const result = await ImageManipulator.manipulateAsync(uri, actions, {
    compress: JPEG_QUALITY,
    format: ImageManipulator.SaveFormat.JPEG, // HEIC / PNG auto-transcoded
    base64: true,
  });
  return {
    data: result.base64 ?? "",
    mediaType: "image/jpeg",
  };
}

/**
 * Chat input bar — pill-shaped GlassView with optional attachment
 * pill row + text input + action row (plus | spacer | mic | send).
 *
 * The send button has three states:
 *   - `arrow.up` (active): user has text OR attached images, tap →
 *     onSend(text, images?)
 *   - `waveform` (idle):   empty composer, tap is a no-op (voice slot, V0.5+)
 *   - `stop.fill` (running): turn is in flight, tap → onInterrupt
 *
 * Attachment flow: `+` button opens a native attachment menu (Camera
 * / Photos via `@react-native-menu/menu` — NOT @expo/ui/community/menu,
 * which wraps SwiftUI Menu in a UIHostingController and conflicts with
 * iOS 14+ auto keyboard avoidance, causing the trigger to drift above
 * sibling Pressables on first keyboard show under system IME); picked
 * assets are compressed (long edge 2576 / JPEG q0.85) and shown as a
 * horizontal pill row above the TextInput until the user sends or
 * removes them. Cap: 8 images per message (Opus 4.7 vision token
 * budget).
 *
 * Liquid Glass requires iOS 26+. On older iOS / Android the GlassView
 * silently falls back to a plain View; the inline `backgroundColor`
 * provides the fallback fill so the surface stays visible.
 */
export function InputBar({
  onSend,
  onInterrupt,
  isRunning,
}: {
  /** Fired on tap-to-send. `images` carries the compressed base64
   *  payloads ready for daemon's sendPrompt; the local DraftAttachment
   *  ids are stripped (parent doesn't need them). Send is gated by
   *  hasText OR images.length > 0 so an images-only message is also
   *  valid (Claude vision accepts an image-only user turn). */
  onSend?: (text: string, images?: ImageAttachment[]) => void;
  onInterrupt?: () => void;
  isRunning?: boolean;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<DraftAttachment[]>([]);
  const draftIdRef = useRef(0);
  const colorScheme = useColorScheme() ?? "light";
  const hasText = text.length > 0;
  // Cap is enforced in three places: PHPicker's selectionLimit
  // (per-pick), Camera early-return guard, and MenuView action
  // `disabled`. We DON'T dim the `+` button itself — the menu will
  // grow other non-image items (voice memo, doc, snippet) that
  // shouldn't be blocked just because the image cap is hit.
  const remainingSlots = MAX_TOTAL_IMAGES - images.length;
  const canAdd = remainingSlots > 0;

  const addAttachments = (atts: ImageAttachment[]) => {
    setImages((prev) => [
      ...prev,
      ...atts.map((a) => ({ ...a, id: `att-${draftIdRef.current++}` })),
    ]);
  };

  const removeAttachment = (id: string) => {
    setImages((prev) => prev.filter((a) => a.id !== id));
  };

  const pickFromCamera = async () => {
    if (!canAdd) return;
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return;
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      quality: 1, // full quality from native picker; we compress after
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    if (!asset) return;
    const att = await compressToAttachment(
      asset.uri,
      asset.width,
      asset.height,
    );
    addAttachments([att]);
  };

  const pickFromLibrary = async () => {
    if (!canAdd) return;
    // PHPicker (iOS 14+) doesn't require library permission for read,
    // but `launchImageLibraryAsync` still pings the permission API on
    // older flows / Android — letting it self-prompt is the cleanest path.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: true,
      // Dynamic cap: only let the user pick the remaining slots so they
      // can't blow past MAX_TOTAL_IMAGES in a single multi-select pass.
      selectionLimit: remainingSlots,
      quality: 1,
    });
    if (result.canceled) return;
    const compressed = await Promise.all(
      result.assets.map((a) => compressToAttachment(a.uri, a.width, a.height)),
    );
    addAttachments(compressed);
  };

  // Images-only messages are valid (Claude vision can answer "what's
  // in this image" without any text), so the send button activates as
  // soon as EITHER text OR images is non-empty.
  const canSend = hasText || images.length > 0;

  const handlePress = () => {
    if (isRunning) {
      onInterrupt?.();
      return;
    }
    if (!canSend) return;
    // Strip local-only `id` field before handing off — daemon protocol
    // only knows {data, mediaType}.
    const payload: ImageAttachment[] | undefined =
      images.length > 0
        ? images.map(({ data, mediaType }) => ({ data, mediaType }))
        : undefined;
    onSend?.(text, payload);
    setText("");
    setImages([]);
  };

  const sendIconName: "arrow.up" | "waveform" | "stop.fill" = isRunning
    ? "stop.fill"
    : canSend
      ? "arrow.up"
      : "waveform";

  return (
    <View className="px-4">
      <GlassView
        isInteractive
        style={{
          borderRadius: 24,
          borderCurve: "continuous",
          // Fallback for iOS<26 / Android — GlassView degrades to plain
          // View, this color shows through. On iOS 26+ it sits behind the
          // Liquid Glass material and is mostly invisible.
          backgroundColor:
            colorScheme === "dark"
              ? "rgba(28,28,30,0.6)"
              : "rgba(255,255,255,0.6)",
          overflow: "hidden", // clip attachment delete badges
        }}
      >
        <View className="py-3 gap-2">
          {/* Attachment pill row — only when there are draft images.
              Horizontal scroll so 8 thumbs fit on narrow screens. The
              X badge sits INSIDE each thumbnail's bounds (not negative
              margin) so the ScrollView doesn't clip it. */}
          {images.length > 0 && (
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerClassName="gap-2 px-3 min-w-full"
            >
              {images.map((img) => (
                <View key={img.id} className="relative">
                  <Image
                    source={{
                      uri: `data:${img.mediaType};base64,${img.data}`,
                    }}
                    className="size-20 rounded-xl border-[0.5px] border-gray-300 dark:border-gray-700"
                    contentFit="cover"
                  />
                  <Pressable
                    onPress={() => removeAttachment(img.id)}
                    hitSlop={8}
                    className="absolute top-1 right-1 size-6 items-center justify-center rounded-full bg-black/75"
                  >
                    <SymbolView
                      name="xmark"
                      size={12}
                      weight="bold"
                      tintColor="#ffffff"
                    />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
          <TextInput
            multiline
            numberOfLines={5}
            value={text}
            onChangeText={setText}
            placeholder="Reply to Claude"
            placeholderTextColor={
              colorScheme === "dark" ? "#71717a" : "#a1a1aa"
            }
            style={{
              color: colorScheme === "dark" ? "#fafafa" : "#0a0a0a",
            }}
            className="text-base px-3"
          />
          <View className="px-3 flex-row items-center justify-between">
            {/* `+` button → native attachment menu via @react-native-menu/menu
                (UIKit UIMenu on iOS, PopupMenu on Android). MenuView wraps
                the trigger Pressable directly; tapping fires `onPressAction`
                with the action's id. Note: `imageColor` MUST be set on each
                action — see comment at the prop. */}
            <MenuView
              actions={[
                {
                  id: "library",
                  title: "Photos",
                  image: "photo.on.rectangle",
                  // SDK 55+ New Arch workaround: native side forwards a
                  // default `0` tint when imageColor is unset, rendering
                  // the SF Symbol as opaque-zero (invisible). Explicit
                  // color is required.
                  // https://github.com/react-native-menu/menu/issues/1198
                  imageColor: colorScheme === "dark" ? "#e4e4e7" : "#3f3f46",
                  attributes: { disabled: !canAdd },
                },
                {
                  id: "camera",
                  title: "Camera",
                  image: "camera",
                  imageColor: colorScheme === "dark" ? "#e4e4e7" : "#3f3f46",
                  attributes: { disabled: !canAdd },
                },
              ]}
              onPressAction={({ nativeEvent: { event } }) => {
                if (event === "camera") pickFromCamera();
                else if (event === "library") pickFromLibrary();
              }}
            >
              <Pressable className="p-1.75 rounded-full">
                <SymbolView
                  name="plus"
                  size={22}
                  weight="regular"
                  tintColor={colorScheme === "dark" ? "#e4e4e7" : "#3f3f46"}
                />
              </Pressable>
            </MenuView>
            <View className="flex-row items-center gap-3">
              <Pressable className="p-1.75">
                <SymbolView
                  name="mic"
                  size={22}
                  weight="regular"
                  tintColor={colorScheme === "dark" ? "#e4e4e7" : "#3f3f46"}
                />
              </Pressable>
              <Pressable
                onPress={handlePress}
                className={`p-1.75 items-center justify-center rounded-full ${
                  colorScheme === "dark" ? "bg-zinc-100" : "bg-zinc-900"
                }`}
              >
                <SymbolView
                  name={sendIconName}
                  size={22}
                  weight="semibold"
                  tintColor={colorScheme === "dark" ? "#0a0a0a" : "#fafafa"}
                />
              </Pressable>
            </View>
          </View>
        </View>
      </GlassView>
    </View>
  );
}
