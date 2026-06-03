import { SymbolView } from "expo-symbols";
import { Pressable, Text, View } from "react-native";
import type { SessionRow as SessionRowData } from "@/lib/sessions-collection";

export interface SessionRowProps {
  session: SessionRowData;
  onPress?: (session: SessionRowData) => void;
  /** Whether this is the globally-selected session — gets a Claude-Desktop
   *  style rounded highlight. Driven by `useGlobalSearchParams` in the
   *  sidebar (the drawer sits outside the session screen, so the active
   *  `cliSessionId` is only reachable via the *global* params, not local). */
  isActive?: boolean;
}

// variableColor.iterative sweeps the ellipsis's three layers in sequence — a
// "…" shimmer that reads as "thinking / generating", matching what a running
// Claude session is doing. expo-symbols' own native symbol effect (no
// reanimated needed); only mounts on running rows.
const RUNNING_SPEC = {
  variableAnimationSpec: { iterative: true, reversing: true },
  repeating: true,
};

// Secondary gray (iOS systemGray) — reads on both light and dark backgrounds,
// so no scheme branch. The shimmer motion (not color) signals "running"; a
// quiet gray keeps the indicator column one tone (idle dot + running ellipsis)
// and stays out of the title's way. Bump to a primary black/white if it ever
// reads too faint on device.
const RUNNING_COLOR = "#8E8E93";

/**
 * One row in the day-sectioned session list. Aligned with Claude Desktop:
 * a leading status indicator + the title on a single line. NO model, NO
 * per-row timestamp (the day section header owns time context), NO cwd
 * (the detail screen's git-status bar owns project context).
 *
 * Status indicator (fixed-width leading slot so the title's left edge stays
 * put across rows):
 *   - running       → animated `ellipsis` (variableColor shimmer)
 *   - idle / other  → a static gray dot
 *
 * `requires_action` is folded into the static dot for now (deferred per the
 * current design pass); revisit when that state gets its own treatment.
 */
export function SessionRow({ session, onPress, isActive }: SessionRowProps) {
  const title = session.title || "Untitled session";
  const isRunning = session.activity === "running";

  return (
    <Pressable
      onPress={onPress ? () => onPress(session) : undefined}
      // Two full static class strings (not a template) so uniwind can extract
      // both. Rows are inset (`mx-2`) + rounded so the active one reads as a
      // pill. No `active:` press variant: uniwind mishandles the stacked
      // `dark:active:` — the dark color leaked into light-mode taps and
      // flashed the row near-black. Plain `dark:` (the active highlight) is
      // fine, and the tapped row becomes active so it highlights anyway.
      className={
        isActive
          ? "mx-2 flex-row items-center gap-2.5 rounded-xl bg-gray-100 px-2 py-2.5 dark:bg-gray-800"
          : "mx-2 flex-row items-center gap-2.5 rounded-xl px-2 py-2.5"
      }
    >
      {/* Fixed-width status slot: the wider running ellipsis and the small
          idle dot both center here so the title never shifts horizontally. */}
      <View className="w-5 items-center justify-center">
        {isRunning ? (
          <SymbolView
            name="ellipsis"
            size={16}
            tintColor={RUNNING_COLOR}
            animationSpec={RUNNING_SPEC}
          />
        ) : (
          <View className="h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600" />
        )}
      </View>
      <Text
        numberOfLines={1}
        className="flex-1 text-base text-black dark:text-white"
      >
        {title}
      </Text>
    </Pressable>
  );
}
