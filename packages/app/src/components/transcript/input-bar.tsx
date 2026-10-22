import {
  formatModelRef,
  type ModelRef,
  parseModelRef,
} from "@thinkite/oc-client";
import {
  useIsRunning,
  useMessages,
  useSession,
} from "@thinkite/oc-client/react";
import { ContextMenu, type MenuAction } from "@yyq1025/react-native-nitro-menu";
import { GlassView } from "expo-glass-effect";
import * as ImageManipulator from "expo-image-manipulator";
import * as ImagePicker from "expo-image-picker";
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
import { useOcDefaultModel, useOcModels } from "@/hooks/use-oc-models";
import { statusColor, useDaemonClient } from "@/lib/daemon-client-context";
import { getOcClient, ocStore } from "@/lib/oc";
import { Image } from "@/lib/styled";
import type { ImageAttachment } from "@/lib/transcript-blocks";

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

/** Format a token count as a short string for the picker menu's
 *  `Context usage: 145k / 200k` header. Switches to `M` once values
 *  hit a million so the 1M-context variant reads as "1M" rather than
 *  "1000k". Round (not floor) so the displayed number tracks intuition
 *  near boundaries; the meter bar's fill width carries the fine-
 *  grained accuracy visually. Drops `.0` so `1_000_000` shows as `1M`
 *  not `1.0M`; keeps one decimal for non-integer M values
 *  (e.g. `1_500_000` → `1.5M`). */
function formatTokensK(n: number): string {
  if (n >= 1_000_000) {
    return `${Number((n / 1_000_000).toFixed(1))}M`;
  }
  return `${Math.round(n / 1000)}k`;
}

/** Tokens the last assistant message put through the context window. */
function lastContextTokens(
  messages: ReturnType<typeof useMessages>,
): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type !== "assistant" || m.tokens === undefined) continue;
    const t = m.tokens;
    return t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
  }
  return undefined;
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
 * Chat input bar — pill-shaped GlassView with optional attachment
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
 * Liquid Glass requires iOS 26+. On older iOS / Android the GlassView
 * silently falls back to a plain View; the inline `backgroundColor`
 * provides the fallback fill so the surface stays visible.
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

  // ─── Session state from the store ───────────────────────────────────
  // Detail: the session's model, busy flag and last turn's context use.
  // New-session: a local draft pick (null = the folder's default, which
  // the store pins on create). A pick on an existing session switches it
  // right away; the picked value wins until the session's model.selected
  // event catches up. Without a pick or a session model (sessions made
  // before new ones were pinned) the folder's default is what runs.
  const models = useOcModels();
  const session = useSession(ocStore, sessionID);
  const messages = useMessages(ocStore, sessionID);
  const isRunning = useIsRunning(ocStore, sessionID);
  const [picked, setPicked] = useState<string | null>(null);
  const sessionModel =
    session?.model !== undefined
      ? formatModelRef(session.model.providerID, session.model.id)
      : null;
  const pinned = picked ?? sessionModel;
  const defaultModel = useOcDefaultModel(
    pinned === null ? (session?.location.directory ?? directory) : undefined,
  );
  const model = pinned ?? defaultModel;
  const currentModel = models.find(
    (m) => formatModelRef(m.providerID, m.id) === model,
  );
  const used = sessionID ? lastContextTokens(messages) : undefined;
  const max = currentModel?.limit.context;
  const contextUsage =
    used !== undefined && max !== undefined && max > 0
      ? { used, max, percentage: Math.min(100, (used / max) * 100) }
      : undefined;
  const onPickModel = (ref: string) => {
    if (ref === pinned) return;
    const previous = picked;
    setPicked(ref);
    if (sessionID === null) return;
    getOcClient()
      .switchModel(sessionID, parseModelRef(ref))
      .catch((err: unknown) => {
        console.error("model switch failed", err);
        setPicked(previous);
      });
  };

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
    onSend?.(text, payload, picked !== null ? parseModelRef(picked) : null);
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
    <View className="px-4">
      <GlassView
        isInteractive
        glassEffectStyle="regular"
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
        }}
      >
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
            placeholderTextColor={
              colorScheme === "dark" ? "#71717a" : "#a1a1aa"
            }
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
              {/* Model picker chip — flat nitro tap menu (UIMenu on iOS,
                  PopupMenu on Android). One row per model the service offers;
                  `state: "on"` on the active row gives the native ✓. */}
              <ContextMenu
                trigger="tap"
                menuConfig={{
                  // Menu-level title — the root UIMenu's `title` renders as a
                  // greyed header above the action rows. Surfaces the meter's
                  // exact numbers (the chip fill alone reads as % only).
                  // Omitted when contextUsage is undefined so the menu doesn't
                  // show an empty header on new-session / pre-first-turn states.
                  title: contextUsage
                    ? `Context usage: ${formatTokensK(contextUsage.used)} / ${formatTokensK(contextUsage.max)}`
                    : undefined,
                  items: models.map<MenuAction>((m) => {
                    const ref = formatModelRef(m.providerID, m.id);
                    return {
                      actionKey: ref,
                      title: m.name,
                      state: ref === model ? "on" : "off",
                    };
                  }),
                }}
                onPressAction={(actionKey) => {
                  onPickModel(actionKey);
                }}
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
                    {currentModel?.name ?? "Model"}
                  </Text>
                </View>
              </ContextMenu>
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
      </GlassView>
    </View>
  );
}
