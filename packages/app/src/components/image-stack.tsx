import { Galeria } from "@nandorojo/galeria";
import { Text, View } from "react-native";
import { Image } from "@/lib/styled";

/**
 * iMessage-style square image stack for chat-bubble attachments.
 *
 * Variants (all handled in one render path — no N-specific branching):
 *  - N=1 → single card with shadow (no fan, no badge)
 *  - N=2/3 → fanned stack (top card + 1-2 peeking cards behind)
 *  - N≥4 → fanned stack + total-count badge (bottom-right of top card)
 *
 * Tap anywhere on the stack opens @nandorojo/galeria at index 0; user
 * swipes left/right inside the viewer to cycle through ALL N images at
 * their original aspect ratio.
 *
 * Layout notes (self-contained, no caller-side padding needed):
 *  - All cards are 160×160 squares; source images are `contentFit:
 *    "cover"` so any aspect ratio collapses cleanly.
 *  - Back/middle cards fan rightward (matching Galeria's L→R swipe).
 *    The frame width grows from 160 (N=1) → 172 (N=2) → 180 (N≥3) to
 *    absorb the rightward peek, so external `pr-*` is unnecessary.
 *
 * Hit-testing notes (iOS-specific):
 *  - Galeria.Image is rendered FIRST and tagged z-30 so the front card
 *    both wins the visual stack AND owns the Pressable hit area.
 *    (Document-order-as-z-order works for visuals but Galeria's native
 *    shared-element transition gets confused when its wrapper sits
 *    under absolute siblings.)
 *  - Back/middle cards + badge use `pointerEvents="none"` so taps fall
 *    through to the Galeria.Image under them.
 *
 * Style notes (iOS-specific):
 *  - Shadow lives on the wrapper View, NOT the Image: `overflow-hidden`
 *    on an iOS View clips its own shadow, and expo-image natively
 *    clips its content to its borderRadius so we don't need
 *    overflow-hidden anywhere.
 *  - N=1 uses the same shadow-lg as the stacked top card — single
 *    images are still "cards", consistent visual language.
 */

const CARD_SIZE_CLASS = "size-40"; // 160×160 per card

// Frame absorbs the rightward fan peek so callers don't add `pr-*`:
//   N=1 → no fan, frame = card size
//   N=2 → middle card peeks ~9px past the card → +12px reserve
//   N=3+ → back card peeks ~17px past the card → +20px reserve
// (Bumping translate-x / scale / rotate later? Recompute these.)
const FRAME_WIDTH_BY_VISIBLE = {
  1: "w-40", // 160
  2: "w-[172px]", // 160 + 12 reserve
  3: "w-[180px]", // 160 + 20 reserve (covers N≥3)
} as const;

export interface ImageStackProps {
  urls: string[];
}

export function ImageStack({ urls }: ImageStackProps) {
  if (urls.length === 0) return null;
  const visibleCount = Math.min(urls.length, 3) as 1 | 2 | 3;
  const frameWidth = FRAME_WIDTH_BY_VISIBLE[visibleCount];

  return (
    <Galeria urls={urls}>
      <View className={`h-40 ${frameWidth}`}>
        {/* Top card — present for ALL N. Render first + z-30 so it
            owns Galeria.Image's hit area AND sits on top visually.
            Badge nested inside so its right-2 anchor sticks to the
            card (not the wider frame for N≥2). */}
        <View
          className={`absolute top-0 left-0 z-30 ${CARD_SIZE_CLASS} rounded-2xl shadow-lg`}
        >
          <Galeria.Image index={0}>
            <Image
              source={{ uri: urls[0] as string }}
              className={`${CARD_SIZE_CLASS} rounded-2xl`}
              contentFit="cover"
              transition={150}
            />
          </Galeria.Image>
          {urls.length >= 4 && (
            <View
              pointerEvents="none"
              className="absolute bottom-2 right-2 rounded-full bg-black/70 px-2.5 py-1"
            >
              <Text className="text-xs font-semibold text-white">
                {urls.length}
              </Text>
            </View>
          )}
        </View>
        {/* Middle card — decorative peek, z-20 */}
        {visibleCount >= 2 && (
          <View
            pointerEvents="none"
            className={`absolute top-0 left-0 z-20 ${CARD_SIZE_CLASS} translate-x-3.5 rotate-2 scale-90 rounded-2xl shadow-md`}
          >
            <Image
              source={{ uri: urls[1] as string }}
              className={`${CARD_SIZE_CLASS} rounded-2xl`}
              contentFit="cover"
            />
          </View>
        )}
        {/* Back card — decorative peek, z-10 (deepest) */}
        {visibleCount >= 3 && (
          <View
            pointerEvents="none"
            className={`absolute top-0 left-0 z-10 ${CARD_SIZE_CLASS} translate-x-7 rotate-4 scale-80 rounded-2xl shadow-md`}
          >
            <Image
              source={{ uri: urls[2] as string }}
              className={`${CARD_SIZE_CLASS} rounded-2xl`}
              contentFit="cover"
            />
          </View>
        )}
      </View>
    </Galeria>
  );
}
