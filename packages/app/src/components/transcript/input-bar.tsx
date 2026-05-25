import { type MenuAction, MenuView } from "@react-native-menu/menu";
import type { EffortLevel, ImageAttachment } from "@sidecodeapp/protocol";
import { GlassView } from "expo-glass-effect";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { type SFSymbol, SymbolView } from "expo-symbols";
import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { useModels } from "@/hooks/use-models";
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

/** SF Symbol name for the gauge variant that represents a given effort
 *  level. The five percent variants iOS 17+ ships (`0/33/50/67/100`)
 *  map cleanly onto the five SDK effort levels in monotonic order, so
 *  the gauge needle visually conveys "more effort" without text. */
const EFFORT_GAUGE_SYMBOL: Record<EffortLevel, SFSymbol> = {
  low: "gauge.with.dots.needle.0percent",
  medium: "gauge.with.dots.needle.33percent",
  high: "gauge.with.dots.needle.50percent",
  xhigh: "gauge.with.dots.needle.67percent",
  max: "gauge.with.dots.needle.100percent",
};

/** Submenu row label for a given effort level. `xhigh` expands to "Extra
 *  High" since the canonical SDK string is opaque to end users; the
 *  others are straight title-case. */
const EFFORT_LABEL: Record<EffortLevel, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** Pick a sensible starting effort when the user switches to a model
 *  whose previously-selected effort isn't supported (or when bootstrapping
 *  from no selection). Prefers `high` when supported, otherwise the
 *  middle of the supported list. */
function pickDefaultEffort(
  supported: readonly EffortLevel[] | undefined,
): EffortLevel | undefined {
  if (!supported || supported.length === 0) return undefined;
  if (supported.includes("high")) return "high";
  return supported[Math.floor(supported.length / 2)];
}

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

  // Model + effort picker state. Local to the input bar for now — when
  // sendPrompt grows `model?` / `effort?` params (V0.5+), lift to a
  // parent / store and pass in as controlled props.
  const { data: models } = useModels();
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [selectedEffort, setSelectedEffort] = useState<EffortLevel | undefined>(
    undefined,
  );
  // Bootstrap to the daemon-declared default on first models payload.
  // Re-runs only when models flips from undefined → array; selectedModel
  // is sticky after that (re-fetches don't reset the user's pick).
  useEffect(() => {
    if (!models || selectedModel !== null) return;
    const def = models.find((m) => m.isDefault) ?? models[0];
    if (!def) return;
    setSelectedModel(def.model);
    setSelectedEffort(pickDefaultEffort(def.supportedEffortLevels));
  }, [models, selectedModel]);
  const currentModel = models?.find((m) => m.model === selectedModel);
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
            // placeholderTextColor is a native prop with no className
            // equivalent — keep the colorScheme ternary for this one.
            placeholderTextColor={
              colorScheme === "dark" ? "#71717a" : "#a1a1aa"
            }
            className="text-base px-3 py-[2.5px] text-zinc-950 dark:text-zinc-50"
          />
          <View className="px-3 flex-row items-center justify-between">
            <View className="flex-row items-center gap-2">
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
                <Pressable className="p-1.75 rounded-full bg-black/5 dark:bg-white/10">
                  <SymbolView
                    name="plus"
                    size={22}
                    weight="regular"
                    tintColor={colorScheme === "dark" ? "#e4e4e7" : "#3f3f46"}
                  />
                </Pressable>
              </MenuView>
              {/* Model picker chip — two-level native menu (UIMenu on iOS,
                  PopupMenu on Android). Each model entry is either a leaf
                  action (Haiku-tier, no effort) or a submenu of its
                  supported effort levels. Selection is reflected via:
                    1. `state: "on"` on the active leaf (native checkmark)
                    2. The chip's own label + gauge symbol
                  Action ID format:
                    - `model:<key>`             leaf model (no effort)
                    - `effort:<key>|<effort>`   effort leaf inside submenu */}
              <MenuView
                actions={(models ?? []).map<MenuAction>((m) => {
                  if (m.supportedEffortLevels === undefined) {
                    return {
                      id: `model:${m.model}`,
                      title: m.displayName,
                      state: m.model === selectedModel ? "on" : "off",
                    };
                  }
                  // No selection indicator on submenu parent rows: UIKit
                  // doesn't honor `state` on `UIMenu` instances (only on
                  // `UIAction`), and the leading-image workaround renders
                  // slightly differently from the native ✓ that leaf rows
                  // (e.g. Haiku) get — inconsistent enough to be worse
                  // than nothing. Current model is conveyed by the chip
                  // label itself; opening the submenu shows the effort
                  // checkmark which doubles as confirmation.
                  return {
                    title: m.displayName,
                    subactions: m.supportedEffortLevels.map((eff) => ({
                      id: `effort:${m.model}|${eff}`,
                      title: EFFORT_LABEL[eff],
                      image: EFFORT_GAUGE_SYMBOL[eff],
                      imageColor:
                        colorScheme === "dark" ? "#e4e4e7" : "#3f3f46",
                      state:
                        m.model === selectedModel && eff === selectedEffort
                          ? "on"
                          : "off",
                    })),
                  };
                })}
                onPressAction={({ nativeEvent: { event } }) => {
                  if (event.startsWith("model:")) {
                    const key = event.slice("model:".length);
                    setSelectedModel(key);
                    setSelectedEffort(undefined);
                  } else if (event.startsWith("effort:")) {
                    const rest = event.slice("effort:".length);
                    const [modelKey, eff] = rest.split("|");
                    if (modelKey && eff) {
                      setSelectedModel(modelKey);
                      setSelectedEffort(eff as EffortLevel);
                    }
                  }
                }}
              >
                <Pressable className="flex-row items-center gap-1 px-3 py-2 rounded-full bg-black/5 dark:bg-white/10">
                  <Text className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
                    {currentModel?.displayName ?? "Model"}
                  </Text>
                  {/* Hide the gauge entirely for effort-less models (Haiku) —
                      no concept to convey. */}
                  {selectedEffort !== undefined && (
                    <SymbolView
                      name={EFFORT_GAUGE_SYMBOL[selectedEffort]}
                      size={16}
                      weight="regular"
                      // Match the chip's text color (zinc-700 / zinc-200) so
                      // the gauge reads as part of the label, not tertiary
                      // metadata.
                      tintColor={colorScheme === "dark" ? "#e4e4e7" : "#3f3f46"}
                    />
                  )}
                </Pressable>
              </MenuView>
            </View>
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
                className="p-1.75 items-center justify-center rounded-full bg-zinc-900 dark:bg-zinc-100"
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
