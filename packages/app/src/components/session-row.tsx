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
import { confirmBridgeToggle } from "@/lib/confirm-bridge-toggle";
import { useDaemonClient } from "@/lib/daemon-client-context";
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

// Secondary gray (iOS systemGray) — reads on both schemes; the shimmer MOTION
// (not color) signals "running".
const RUNNING_COLOR = "#8E8E93";
// Trailing cloud badge tint — Claude's brand orange (#DA7756, the exact hex
// Claude Code's CLI uses for its `claudeOrange`). A bridged row should read as
// "Claude remote control is ON", not ambient chrome, so we tint it the brand
// color rather than burying it in tertiary gray. One value for both schemes:
// it's a brand mark, and it clears contrast on white and black alike.
const BRIDGED_COLOR = "#DA7756";
// Selected-row highlight + press feedback. Press is intentionally a tone darker/
// lighter than active so a tap reads distinctly.
const ACTIVE_BG = { light: "#F3F4F6", dark: "#1F2937" } as const; // gray-100 / gray-800
const PRESS_BG = { light: "#E5E7EB", dark: "#374151" } as const; // gray-200 / gray-700
// Lifted context-menu preview card background — a solid elevated surface so the
// row (whose own bg is transparent when idle) reads as a card when it floats.
const PREVIEW_BG = { light: "#FFFFFF", dark: "#1C1C1E" } as const;

// The leading status glyph and the trailing cloud badge share one size so the
// row's two icon slots stay vertically balanced.
const ICON_SIZE = 16;
// Uniform single-line row height.
const ROW_HEIGHT = 44;

/**
 * One row in the day-sectioned session list. Aligned with Claude Desktop:
 * a leading status indicator + the title on a single line. NO model, NO
 * per-row timestamp (the day section header owns time context), NO cwd
 * (the detail screen's git-status bar owns project context).
 *
 * A tap opens the session; a long-press lifts the row into a native iOS context
 * menu (`@yyq1025/react-native-nitro-menu` — our published fork of
 * react-native-nitro-contextmenu) with a working lift preview. The menu carries
 * the CCR bridge toggle ("Start Remote Control" / "Make private"); the lifted
 * preview shows the row itself so you can see which session you're acting on.
 *
 * This replaces the earlier `ActionSheetIOS` long-press: the fork bakes in the
 * New-Arch lift-preview fix (renders live trigger content, text included) + a
 * list-safety wrapper (no recycler index desync) + a `style` prop to size the
 * cell, so a per-row native menu finally coexists with RN list virtualization —
 * the failure mode that pushed us to a plain action sheet before. (Earlier
 * attempts — @expo/ui ContextMenu, community/menu, react-native-ios-context-menu
 * — either fought virtualization or wouldn't link on RN 0.85.)
 *
 * Press feedback uses the Pressable's `style={({ pressed }) => …}` callback (NOT
 * uniwind's `active:` — uniwind mishandles stacked `dark:active:` and flashes
 * the row near-black, and doesn't instrument the RNGH Pressable anyway). The
 * background lives in the style function so the pressed/active states are clean
 * JS, not className variants. iOS-only menu surface.
 *
 * Status indicator (fixed-width leading slot so the title's left edge stays
 * put across rows): running → animated `ellipsis`; idle/other → a gray dot.
 * Trailing slot: a filled `cloud.fill` in Claude's brand orange iff
 * CCR-bridged — reads at a glance as "remote control on", not ambient chrome.
 * `requires_action` is folded into the static dot for now.
 */
export function SessionRow({ session, onPress, isActive }: SessionRowProps) {
  const title = session.title || "Untitled session";
  const isRunning = session.activity === "running";
  // Optional on the wire — only an explicit `true` is bridged (undefined = pure).
  const isBridged = session.bridged === true;
  const scheme = useColorScheme() === "dark" ? "dark" : "light";
  const { client } = useDaemonClient();

  // Single toggle action — parity with the action sheet it replaced. (Delete et
  // al. land here once the daemon grows the RPCs; the menu surface is now ready
  // for them.) The title goes on the action, not a menu header, so it reads as
  // a verb; the lifted preview already shows which row you're on. Icon vocab
  // matches the detail-screen header toggle: laptopcomputer (private/your Mac)
  // ↔ cloud (remote control).
  const menuConfig: MenuConfig = {
    items: [
      {
        actionKey: "bridge",
        title: isBridged ? "Make private" : "Start Remote Control",
        image: { systemName: isBridged ? "laptopcomputer" : "cloud" },
      },
    ],
  };

  // Confirm-then-toggle via the shared helper (same Alert copy + dispatch as the
  // header button); the `bridged` flag flips on the daemon broadcast, not
  // optimistically.
  const onAction = (actionKey: string) => {
    if (actionKey === "bridge") {
      confirmBridgeToggle(client, session.cliSessionId, isBridged);
    }
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
        {/* Trailing cloud badge: only mounts when bridged, so pure rows stay the
            clean `[status] title`. */}
        {isBridged ? (
          <SymbolView
            name="cloud.fill"
            size={ICON_SIZE}
            tintColor={BRIDGED_COLOR}
          />
        ) : null}
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
