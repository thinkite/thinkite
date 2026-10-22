import { ContextMenu, type MenuConfig } from "@yyq1025/react-native-nitro-menu";
import { SymbolView } from "expo-symbols";
import { StyleSheet, Text, useColorScheme, View } from "react-native";
// RNGH's Pressable (native gesture recognizer), NOT RN's (JS responder): the
// row sits inside a `@yyq1025/react-native-nitro-menu` long-press context menu
// AND inside the drawer (horizontal swipe). RN's Pressable arbitrates in a
// separate system from the native UIContextMenuInteraction + the drawer pan, so
// its tap loses to the long-press; RNGH's recognizer is arbitrated by UIKit
// alongside both, so tap → open / long-press → menu / horizontal pan → drawer
// all negotiate cleanly. Styled via the `style` function (not uniwind
// `className`): uniwind doesn't instrument third-party components, and the
// pressed/active background needs the Pressable's `{ pressed }` state callback —
// which the className→style merge would flatten away.
import { Pressable } from "react-native-gesture-handler";
import type { OcSessionRow as SessionRowData } from "@/hooks/use-sessions";
import { getOcClient } from "@/lib/oc";

export interface SessionRowProps {
  session: SessionRowData;
  onPress?: (session: SessionRowData) => void;
  /** Whether this is the globally-selected session — gets a Claude-Desktop
   *  style rounded highlight. Driven by `useGlobalSearchParams` in the
   *  sidebar (the drawer sits outside the session screen, so the active
   *  session id is only reachable via the *global* params, not local). */
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

// Secondary gray (iOS systemGray) — reads on both schemes; the shimmer MOTION
// (not color) signals "running".
const RUNNING_COLOR = "#8E8E93";
// Selected-row highlight + press feedback. Press is intentionally a tone darker/
// lighter than active so a tap reads distinctly.
const ACTIVE_BG = { light: "#F3F4F6", dark: "#1F2937" } as const; // gray-100 / gray-800
const PRESS_BG = { light: "#E5E7EB", dark: "#374151" } as const; // gray-200 / gray-700
// Lifted context-menu preview card background — a solid elevated surface so the
// row (whose own bg is transparent when idle) reads as a card when it floats.
const PREVIEW_BG = { light: "#FFFFFF", dark: "#1C1C1E" } as const;

// The leading status glyph size.
const ICON_SIZE = 16;
// Uniform single-line row height.
const ROW_HEIGHT = 44;

/**
 * One row in the day-sectioned opencode session list. Aligned with Claude
 * Desktop: a leading status indicator + the title on a single line. NO
 * model, NO per-row timestamp (the day section header owns time context),
 * NO cwd (the detail screen's git-status bar owns project context).
 *
 * A tap opens the session; a long-press lifts the row into a native iOS context
 * menu (`@yyq1025/react-native-nitro-menu` — our published fork of
 * react-native-nitro-contextmenu) with a working lift preview. The menu carries
 * "Delete session" — the documented v1 compat DELETE (no v2 delete route in
 * 1.18.30), which also evicts the cached transcript so a recreated id never
 * serves stale rows. The lifted preview shows the row itself so you can see
 * which session you're acting on.
 *
 * This replaces the earlier `ActionSheetIOS` long-press and the pre-opencode
 * bridge toggle: the fork bakes in the New-Arch lift-preview fix (renders live
 * trigger content, text included) + a list-safety wrapper (no recycler index
 * desync) + a `style` prop to size the cell, so a per-row native menu finally
 * coexists with RN list virtualization — the failure mode that pushed us to a
 * plain action sheet before.
 *
 * Press feedback uses the Pressable's `style={({ pressed }) => …}` callback (NOT
 * uniwind's `active:` — uniwind mishandles stacked `dark:active:` and flashes
 * the row near-black, and doesn't instrument the RNGH Pressable anyway). The
 * background lives in the style function so the pressed/active states are clean
 * JS, not className variants. iOS-only menu surface.
 *
 * Status indicator (fixed-width leading slot so the title's left edge stays
 * put across rows): running → animated `ellipsis`; idle/other → a gray dot.
 */
export function SessionRow({ session, onPress, isActive }: SessionRowProps) {
  const title = session.title || "Untitled session";
  const isRunning = session.running;
  const scheme = useColorScheme() === "dark" ? "dark" : "light";

  const menuConfig: MenuConfig = {
    items: [
      {
        actionKey: "delete",
        title: "Delete session",
        image: { systemName: "trash" },
        attributes: ["destructive"],
      },
    ],
  };

  // The session.deleted bus event removes the row.
  const onAction = (actionKey: string) => {
    if (actionKey !== "delete") return;
    void getOcClient()
      .deleteSession(session.id)
      .catch((err) => {
        console.warn("[session-row] delete failed:", err);
      });
  };

  return (
    // `style` sizes the cell (the lib's internal collapsable wrapper) to the row
    // height — gives the lifted host a stable single-child parent so the lift's
    // index-restore stays valid across list recycling. Tapping the lifted
    // preview just dismisses (no pop/morph into a detail); the menu carries the
    // actions.
    <ContextMenu
      trigger="longPress"
      menuConfig={menuConfig}
      previewConfig={{
        previewType: "view",
        borderRadius: 12,
        backgroundColor: PREVIEW_BG[scheme],
        preferredCommitStyle: "dismiss",
      }}
      onPressAction={onAction}
      style={styles.cell}
    >
      <Pressable
        onPress={onPress ? () => onPress(session) : undefined}
        style={({ pressed }) => [
          styles.row,
          {
            backgroundColor: pressed
              ? PRESS_BG[scheme]
              : isActive
                ? ACTIVE_BG[scheme]
                : "transparent",
          },
        ]}
      >
        {/* Fixed-width status slot: the wider running ellipsis and the small idle
            dot both center here so the title never shifts horizontally. */}
        <View className="w-4 items-center justify-center">
          {isRunning ? (
            <SymbolView
              name="ellipsis"
              size={ICON_SIZE}
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
    </ContextMenu>
  );
}

const styles = StyleSheet.create({
  // The lib's collapsable wrapper is sized here to the row height (no extra
  // margin — the list's `gap-1.5` spaces rows). Full row height keeps the lift
  // host a stable single child.
  cell: { height: ROW_HEIGHT },
  // Row layout (was uniwind `w-full flex-row items-center gap-2.5 rounded-xl
  // px-2`): inline because the RNGH Pressable isn't uniwind-instrumented and the
  // pressed/active bg is applied in the same style callback. `rounded-xl` (12)
  // clips the highlight fill; `px-2` (8) insets content within the list's own
  // `px-2`.
  row: {
    height: ROW_HEIGHT,
    width: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    borderRadius: 12,
  },
});
