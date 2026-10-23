import { type ModelRef, variantLabel } from "@thinkite/oc-client";
import { useIsRunning } from "@thinkite/oc-client/react";
import { ContextMenu } from "@yyq1025/react-native-nitro-menu";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import {
  modelRef,
  useContextUsage,
  useModelChoice,
} from "@/hooks/use-model-choice";
import { statusColor, useDaemonClient } from "@/lib/daemon-client-context";
import { getOcClient, ocStore } from "@/lib/oc";
import { Image } from "@/lib/styled";
import type { ImageAttachment } from "@/lib/transcript-blocks";
import { ComposerGlass } from "./composer-glass";

/**
 * Local-only id so the pill row can have stable React keys + a cheap
 * remove path; never sent (an ImageAttachment is just {data, mediaType}).
 * Generated with a monotonic counter so we don't pull in a UUID lib for
 * what's effectively a render hint.
 */
interface DraftAttachment extends ImageAttachment {
  id: string;
}

/**
 * Color for the context meter fill on the model picker chip. Three
 * tiers tuned to feel informational at low usage and clearly warn near
 * the cap:
 *
 *   - <70%: iOS system blue — visible as a "this exists, it's
 *     tracking" signal without alarming. Lighter opacity in light
 *     mode (chip background `bg-black/5` is pale, so blue at 0.30
 *     reads too saturated); kept at 0.30 in dark mode (chip
 *     `bg-white/10` needs more contrast).
 *   - 70–90%: amber — "you should consider compacting soon."
 *   - ≥90%: red — "next turn likely to auto-compact or get clipped."
 *
 * Warning tiers (amber/red) use a single opacity on both themes — both
 * read as alarming enough either way. Only the informational blue
 * needs the theme-aware split.
 *
 * Thresholds roughly mirror the agents' auto-compact heuristics —
 * warnings in the mid-70s, compaction in the high 80s/90s.
 */
function meterFillColor(percentage: number, isDark: boolean): string {
  if (percentage >= 90) return "rgba(239, 68, 68, 0.50)"; // red-500
  if (percentage >= 70) return "rgba(245, 158, 11, 0.40)"; // amber-500
  // iOS systemBlue (#007aff)
  return isDark ? "rgba(0, 122, 255, 0.30)" : "rgba(0, 122, 255, 0.18)";
}

/** Vision input cap of the large models: long edge 2576px, ≤3.75MP. We
 *  resize the long edge then let JPEG q0.85 do the bytes work; the image
 *  goes inline as a data URI, so nothing is written to disk. */
const MAX_LONG_EDGE = 2576;
const JPEG_QUALITY = 0.85;
/** Total draft attachment cap per message: a high-res vision budget
 *  (~4K tok/image × 8 = 32K of a 200K window) that also matches
 *  PHPicker's single-pick max, so users hit the cap in one Photos tap.
 *  Tune in one spot. */
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
 * Chat input bar — pill-shaped glass with optional attachment
 * pill row + text input + action row (plus + model chip | spacer | send).
 *
 * Self-sourcing: pass `sessionID` and InputBar derives the model picker,
 * the context meter and the running state from the oc-client store (or a
 * local draft model when `sessionID` is null = new-session), and owns
 * interrupt. The ONLY other prop is `onSend` — the screen-specific "what
 * does sending mean here" action (new-session: createSession + navigate;
 * detail: optimistic prompt), which InputBar can't own.
 *
 * The send button has two icon states (+ a disabled/dimmed idle):
 *   - `arrow.up` (active): user has text OR attached images, tap → onSend.
 *     While a turn runs the message queues behind it, as in opencode's own
 *     clients. Empty composer → same arrow, but disabled + dimmed.
 *   - `stop.fill` (running, empty composer): tap → interrupt.
 * Offline → disabled + dimmed in every state (write gate); a status dot
 * sits just left of the button.
 *
 * Attachment flow: `+` button opens a native attachment menu (Camera
 * / Photos via the nitro tap menu `@yyq1025/react-native-nitro-menu` —
 * a pure-UIKit UIButton+UIMenu, NOT @expo/ui/community/menu, which wraps
 * SwiftUI Menu in a UIHostingController and conflicts with iOS 14+ auto
 * keyboard avoidance, drifting the trigger above sibling icons on first
 * keyboard show under system IME); picked assets are compressed (long
 * edge 2576 / JPEG q0.85) and shown as a horizontal pill row above the
 * TextInput until the user sends or removes them.
 *
 * The pill is ComposerGlass, shared with the prompt cards that replace the
 * InputBar while a permission request or question waits.
 */
export function InputBar({
  sessionID,
  directory,
  onSend,
}: {
  /** The session this composer drives, or `null` on the new-session
   *  screen (no session exists yet; the draft model rides out on `onSend`). */
  sessionID: string | null;
  /** New-session only: the folder the session will open in, whose default
   *  model the picker shows until the user picks one. */
  directory?: string;
  /** Fired on send. `images` carries the compressed base64 payloads
   *  (local DraftAttachment ids stripped); `model` is the picked model, or
   *  null for the session's (or the service's) current one. Send is gated
   *  by hasText OR images.length > 0, so an images-only message is valid. */
  onSend?: (
    text: string,
    images: ImageAttachment[] | undefined,
    model: ModelRef | null,
  ) => void;
}) {
  const { connectionStatus } = useDaemonClient();
  // Write gate: only an established tunnel (online) accepts sends /
  // interrupts. connecting / offline / error all gate. Disabling the
  // affordance here is the primary prevention — no optimistic bubble, no
  // hung promise. Reads (model draft, attachments) stay usable offline.
  const online = connectionStatus === "online";
  const [text, setText] = useState("");
  const [images, setImages] = useState<DraftAttachment[]>([]);

  // ─── Model, effort and context use ──────────────────────────────────
  // What the composer runs on (hooks/use-model-choice): a session's model,
  // or the new session's draft. The chip opens the model-picker sheet,
  // which picks through the same hook.
  const isRunning = useIsRunning(ocStore, sessionID);
  const { info, model, variant, isPicked } = useModelChoice(
    sessionID,
    directory,
  );
  const contextUsage = useContextUsage(sessionID, info?.limit.context);
  const openPicker = () =>
    router.push({
      pathname: "/model-picker",
      params:
        sessionID !== null
          ? { session: sessionID }
          : directory !== undefined
            ? { directory }
            : {},
    });

  const draftIdRef = useRef(0);
  const colorScheme = useColorScheme() ?? "light";
  const hasText = text.length > 0;

  // Cap is enforced in three places: PHPicker's selectionLimit
  // (per-pick), Camera early-return guard, and the attachment menu's
  // `disabled` attribute. We DON'T dim the `+` button itself — the menu
  // will grow other non-image items (doc, snippet, etc.) that
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

  // Images-only messages are valid (a vision model can answer "what's
  // in this image" without any text), so the send button activates as
  // soon as EITHER text OR images is non-empty.
  const canSend = hasText || images.length > 0;

  const handlePress = () => {
    // Write gate: offline → no send, no interrupt (both need a live
    // round-trip and would otherwise hang). The button is also visually
    // disabled below; this is the logic guard.
    if (!online) return;
    if (!canSend) {
      // Empty composer during a turn = the stop button.
      if (isRunning && sessionID) {
        getOcClient()
          .interrupt(sessionID)
          .catch((err: unknown) => {
            console.error("interrupt failed", err);
          });
      }
      return;
    }
    // Strip the local-only `id` before handing off.
    const payload: ImageAttachment[] | undefined =
      images.length > 0
        ? images.map(({ data, mediaType }) => ({ data, mediaType }))
        : undefined;
    onSend?.(
      text,
      payload,
      isPicked && model !== null ? modelRef(model, variant) : null,
    );
    setText("");
    setImages([]);
  };

  const sendIconName: "arrow.up" | "stop.fill" =
    isRunning && !canSend ? "stop.fill" : "arrow.up";
  // The send button is actionable only when online AND there's something
  // to do (text/images to send, or a running turn to interrupt). Empty
  // composer or offline → dimmed + disabled.
  const sendActive = online && (canSend || isRunning);

  return (
    <ComposerGlass>
      <View className="py-3 gap-3 rounded-3xl border-continuous overflow-hidden">
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
          placeholder="Message opencode"
          // placeholderTextColor is a native prop with no className
          // equivalent — keep the colorScheme ternary for this one.
          placeholderTextColor={colorScheme === "dark" ? "#71717a" : "#a1a1aa"}
          className="text-base px-3 py-[2.5px] text-zinc-950 dark:text-zinc-50"
        />
        <View className="px-3 flex-row items-center justify-between">
          <View className="flex-row items-center gap-2">
            {/* `+` button → native attachment menu via the nitro tap menu
                  (a transparent showsMenuAsPrimaryAction UIButton + UIMenu on
                  iOS, PopupMenu on Android — pure UIKit, no UIHostingController,
                  so it stays put on first keyboard show; that immunity is why
                  we don't use @expo/ui here). The trigger content renders under
                  the overlay button (so a plain View, not a Pressable); tapping
                  fires `onPressAction` with the `actionKey`. No `imageColor`
                  needed — UIKit template-tints the SF Symbol. */}
            <ContextMenu
              trigger="tap"
              menuConfig={{
                items: [
                  {
                    actionKey: "library",
                    title: "Photos",
                    image: { systemName: "photo.on.rectangle" },
                    attributes: canAdd ? [] : ["disabled"],
                  },
                  {
                    actionKey: "camera",
                    title: "Camera",
                    image: { systemName: "camera" },
                    attributes: canAdd ? [] : ["disabled"],
                  },
                ],
              }}
              onPressAction={(actionKey) => {
                if (actionKey === "camera") pickFromCamera();
                else if (actionKey === "library") pickFromLibrary();
              }}
            >
              <View className="p-1.75 rounded-full bg-black/5 dark:bg-white/10">
                <SymbolView
                  name="plus"
                  size={22}
                  weight="regular"
                  tintColor={colorScheme === "dark" ? "#e4e4e7" : "#3f3f46"}
                />
              </View>
            </ContextMenu>
            {/* Model chip — opens the model-picker sheet (search, the
                  catalog by provider, the current model's effort and
                  context use). Names the model, and its effort when not
                  the default. */}
            <Pressable
              onPress={openPicker}
              accessibilityRole="button"
              accessibilityLabel="Choose model"
            >
              {/* Context meter — fills the chip background left→right
                    proportional to context-window usage. `overflow-hidden`
                    clips the absolute fill to the rounded-full silhouette;
                    the fill is the FIRST child so the Text label naturally
                    layers on top (RN sibling order = z-order). No extra
                    layout cost when `contextUsage` is undefined — the
                    null branch skips the absolute View entirely. */}
              <View className="relative flex-row items-center gap-1 px-3 py-2 rounded-full bg-black/5 dark:bg-white/10 overflow-hidden">
                {contextUsage && (
                  <View
                    className="absolute inset-y-0 left-0"
                    style={{
                      width: `${contextUsage.percentage}%`,
                      backgroundColor: meterFillColor(
                        contextUsage.percentage,
                        colorScheme === "dark",
                      ),
                    }}
                  />
                )}
                <Text className="text-sm text-zinc-700 dark:text-zinc-200">
                  {info?.name ?? "Model"}
                  {variant !== "default" ? ` · ${variantLabel(variant)}` : ""}
                </Text>
              </View>
            </Pressable>
          </View>
          <View className="flex-row items-center gap-3">
            {/* Write-gate status dot — sits just left of send, shown only
                  when NOT online (connecting/offline = gray, error = red, per
                  statusColor). Signals "composer can't send right now"; the
                  send button beside it is disabled + dimmed. */}
            {!online && (
              <View
                className="size-2 rounded-full"
                style={{ backgroundColor: statusColor(connectionStatus) }}
              />
            )}
            <Pressable
              onPress={handlePress}
              disabled={!sendActive}
              style={{ opacity: sendActive ? 1 : 0.4 }}
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
    </ComposerGlass>
  );
}
