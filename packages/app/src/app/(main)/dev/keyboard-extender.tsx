import { GlassView } from "expo-glass-effect";
import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import { useMemo, useState } from "react";
import {
  Animated,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import {
  KeyboardBackgroundView,
  KeyboardStickyView,
  useKeyboardAnimation,
  useKeyboardState,
} from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

/**
 * Dev spike — slash-command UX experiments. Two threads:
 *
 * 1. KeyboardExtender → KSV + KeyboardBackgroundView pivot. Keeps
 *    `/`-button tool row attached to the keyboard via KSV. See the
 *    `<AnimatedKeyboardBackgroundView>` block below for the offset /
 *    opacity / pointerEvents trio that hides it when keyboard is down.
 *
 * 2. Slash-command panel positioning. Two designs we tried:
 *
 *    A) Swap GitStatusBar ↔ SlashPanel in the composer slot.
 *       → REJECTED: composer measured height jumps 40 → up to 240pt,
 *         contentInsetEndAdjustment recomputes, transcript shifts
 *         down ~200pt. Feels like the whole UI lurched.
 *
 *    B) **Current: overlay panel above composer top** (this file).
 *       → GitStatusBar stays mounted, composer measured height stays
 *         stable, transcript doesn't move. Panel floats absolute-
 *         positioned over the composer top with `bottom: COMPOSER_
 *         VISUAL_HEIGHT + 8`. Hard-capped to 3 rows (≈152pt) so it
 *         fits even on iPhone SE under a keyboard.
 *
 *    Trigger rule (cursor-aware): take the substring from start of
 *    text up to the cursor, panel shows when THAT segment starts with
 *    `/` AND has no space. Lets the user cursor BACK into the command
 *    name (e.g. to fix a typo) and reopen the panel without clearing
 *    parameter text after it. Mid-text `/` after non-whitespace is a
 *    literal slash (the segment won't start with `/`). Space dismisses.
 */
const TOOL_ROW_HEIGHT = 40;

// Eyeballed visual height of the composer block (GitStatusBar + InputBar
// + their padding). Real ChatPanel measures this dynamically via
// composerRef + onLayout; for the spike we hardcode. If you tweak the
// mocks below, re-measure.
const COMPOSER_VISUAL_HEIGHT = 145;

// 3 rows × ~48pt (Pressable row) + 8pt vertical padding. Lock the cap
// regardless of how many commands match so panel height is predictable
// across devices.
const PANEL_MAX_HEIGHT = 152;

export default function KeyboardExtenderDevScreen() {
  const insets = useSafeAreaInsets();
  const isDark = useColorScheme() === "dark";
  const { progress } = useKeyboardAnimation();
  const isKeyboardVisible = useKeyboardState((s) => s.isVisible);
  // Memoize once — recreating the wrapped component each render is wasteful
  // and would defeat React reconciliation.
  const AnimatedKeyboardBackgroundView = useMemo(
    () => Animated.createAnimatedComponent(KeyboardBackgroundView),
    [],
  );
  const [text, setText] = useState("");
  const [selection, setSelection] = useState({ start: 0, end: 0 });

  // Panel detection is CURSOR-AWARE: only the segment from start of text
  // up to the cursor matters. This way:
  //   - typing `/`, then `m`, then `o`... → panel filters as you type
  //   - typing space after the command name → panel dismisses (entered
  //     parameter mode)
  //   - tapping cursor BACK into the command-name segment (e.g. to fix
  //     a typo in `/modle`) → panel reopens with current prefix
  //   - any `/` AFTER text or whitespace → not treated as a command
  //     trigger (literal slash, e.g. in filepaths)
  const beforeCursor = text.slice(0, selection.start);
  const isCommandMode =
    beforeCursor.startsWith("/") && !beforeCursor.includes(" ");
  const commandPrefix = isCommandMode ? beforeCursor.slice(1) : "";
  const filtered = MOCK_COMMANDS.filter((c) =>
    c.name.startsWith(commandPrefix),
  );

  const insertSlash = () => {
    const { start, end } = selection;
    const safeStart = Math.max(0, Math.min(start, text.length));
    const safeEnd = Math.max(safeStart, Math.min(end, text.length));
    const next = text.slice(0, safeStart) + "/" + text.slice(safeEnd);
    setText(next);
    const cursor = safeStart + 1;
    setSelection({ start: cursor, end: cursor });
  };

  const pickCommand = (cmd: string) => {
    // IDE-style replace: swap ONLY the command-name segment (from `/`
    // through the first space, or to end of text if no space), keep any
    // parameter text after that space. So `/mo|del claude-opus` →
    // pick `/model` → `/model claude-opus`, cursor at start of params.
    const firstSpace = text.indexOf(" ");
    const head = `/${cmd}`;
    const tail = firstSpace >= 0 ? text.slice(firstSpace) : " ";
    setText(head + tail);
    // Cursor lands right after `/cmd ` — at the parameter start.
    const cursor = head.length + 1;
    setSelection({ start: cursor, end: cursor });
  };

  return (
    <>
      <Stack.Screen options={{ title: "KeyboardExtender spike" }} />
      <View className="flex-1 bg-white dark:bg-black">
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-base text-zinc-600 dark:text-zinc-300">
            Focus the input, then type `/` or tap the `/` button in the
            tool row (only colored accent when cursor is at position 0).
            {"\n\n"}
            Panel hovers ABOVE the composer — GitStatusBar stays mounted
            so composer height doesn't jump. Capped at 3 rows + scroll.
            {"\n\n"}
            Type a space (or cursor past it) to dismiss; cursor back into
            the command name to reopen.
          </Text>
        </View>

        {/* Single KSV holds the whole composer chrome — panel/git-status,
            InputBar, AND tool row stacked bottom-up. The tool row is the
            bottommost child so it eats the safe-area zone (and 6pt past
            the screen edge on iPhone X+) when keyboard is closed.

            Offsets:
            - closed: TOOL_ROW_HEIGHT - insets.bottom
                = push the whole KSV down by `TR - insets.bottom`. Net
                effect: InputBar bottom lands exactly at insets.bottom
                above screen edge (same as it was without the tool row),
                tool row occupies the safe-area band + 6pt off-screen.
                When insets.bottom = 0 (no home indicator) → push down a
                full 40pt → tool row fully hidden.
            - opened: 0
                tool row's bottom flush with keyboard top, no see-through
                strip between them. */}
        <KeyboardStickyView
          offset={{
            closed: TOOL_ROW_HEIGHT - insets.bottom,
            opened: 0,
          }}
          style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
        >
          {/* SlashPanel as OVERLAY — absolute-positioned, sits above
              the composer top with an 8pt gap. Doesn't enter the
              composer's measured height in production (here we use a
              static `COMPOSER_VISUAL_HEIGHT` constant; real ChatPanel
              reads it from contentInsetEndAdjustment SharedValue).

              GitStatusBar stays mounted underneath — visually hidden
              by the panel but layout-stable. */}
          {isCommandMode && (
            <View
              pointerEvents="box-none"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                bottom: COMPOSER_VISUAL_HEIGHT + TOOL_ROW_HEIGHT + 8,
              }}
            >
              <SlashPanel
                commands={filtered}
                isDark={isDark}
                onPick={pickCommand}
              />
            </View>
          )}

          {/* Composer chrome — always rendered, stable height */}
          <GitStatusBarMock isDark={isDark} />

          <View className="px-4 pb-2">
            <View
              style={{
                borderRadius: 24,
                paddingVertical: 8,
                backgroundColor: isDark
                  ? "rgba(28,28,30,0.6)"
                  : "rgba(255,255,255,0.6)",
              }}
            >
              <TextInput
                multiline
                value={text}
                onChangeText={setText}
                selection={selection}
                onSelectionChange={(e) => setSelection(e.nativeEvent.selection)}
                placeholder='Type "/" or tap the / button below'
                placeholderTextColor={isDark ? "#71717a" : "#a1a1aa"}
                autoCorrect={false}
                autoCapitalize="none"
                style={{
                  color: isDark ? "#fafafa" : "#0a0a0a",
                  borderRadius: 12,
                  marginHorizontal: 8,
                  minHeight: 40,
                }}
                className="text-base px-3 py-2"
              />
              <View className="px-3 flex-row items-center justify-between">
                <Text className="text-xs text-zinc-500 dark:text-zinc-400">
                  {isCommandMode
                    ? `/${commandPrefix} · ${filtered.length} match${filtered.length === 1 ? "" : "es"}`
                    : "—"}
                </Text>
                <Pressable className="p-1.75">
                  <SymbolView
                    name="paperplane.fill"
                    size={22}
                    weight="regular"
                    tintColor={isDark ? "#e4e4e7" : "#3f3f46"}
                  />
                </Pressable>
              </View>
            </View>
          </View>

          {/* Tool row — bottommost child of the single KSV. Geometrically
              it occupies the safe-area zone + 6pt off-screen when keyboard
              is closed (see header comment), but visually that band would
              still show the backdrop blur and look like a bug.

              Two-layer hide when closed:
              1. `opacity` animates from 0 → 1 with keyboard progress
                 (lib's documented Android-fallback pattern via
                 `useKeyboardAnimation`).
              2. `pointerEvents` gated on `isKeyboardVisible` — opacity 0
                 alone doesn't block taps in RN, so the invisible band
                 would still capture presses on the `/` button. */}
          <AnimatedKeyboardBackgroundView
            style={{ height: TOOL_ROW_HEIGHT, opacity: progress }}
            pointerEvents={isKeyboardVisible ? "auto" : "none"}
          >
            <View
              style={{
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                paddingHorizontal: 16,
                gap: 8,
              }}
            >
              <Pressable
                onPress={insertSlash}
                hitSlop={8}
                style={({ pressed }) => ({
                  paddingHorizontal: 10,
                  paddingVertical: 4,
                  borderRadius: 8,
                  backgroundColor: pressed
                    ? isDark
                      ? "#3f3f46"
                      : "#e4e4e7"
                    : "transparent",
                })}
              >
                <Text
                  style={{
                    fontSize: 18,
                    fontWeight: "600",
                    // Accent when cursor is at position 0 — tap will
                    // start a slash command (inserted `/` becomes the
                    // first char, panel opens). Muted otherwise — tap
                    // just inserts a literal `/` mid-text.
                    color:
                      selection.start === 0
                        ? "#007aff"
                        : isDark
                          ? "#71717a"
                          : "#a1a1aa",
                  }}
                >
                  /
                </Text>
              </Pressable>
              <Text className="text-xs text-zinc-500 dark:text-zinc-400">
                tools (+ later: 📎 🎤 ctx-meter)
              </Text>
            </View>
          </AnimatedKeyboardBackgroundView>
        </KeyboardStickyView>
      </View>
    </>
  );
}

function SlashPanel({
  commands,
  isDark,
  onPick,
}: {
  commands: typeof MOCK_COMMANDS;
  isDark: boolean;
  onPick: (cmd: string) => void;
}) {
  return (
    <View className="px-4">
      <GlassView
        isInteractive
        style={{
          borderRadius: 18,
          borderCurve: "continuous",
          backgroundColor: isDark
            ? "rgba(28,28,30,0.55)"
            : "rgba(255,255,255,0.55)",
          maxHeight: PANEL_MAX_HEIGHT,
        }}
      >
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingVertical: 4 }}
        >
          {commands.length === 0 ? (
            <View className="px-4 py-3">
              <Text className="text-sm text-zinc-500 dark:text-zinc-400">
                No matching commands
              </Text>
            </View>
          ) : (
            commands.map((c) => (
              <Pressable
                key={c.name}
                onPress={() => onPick(c.name)}
                className="px-4 py-2 flex-row items-center gap-3"
              >
                <Text className="text-sm font-medium text-zinc-900 dark:text-zinc-100 w-20">
                  /{c.name}
                </Text>
                <Text
                  className="flex-1 text-sm text-zinc-500 dark:text-zinc-400"
                  numberOfLines={1}
                >
                  {c.description}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </GlassView>
    </View>
  );
}

function GitStatusBarMock({ isDark }: { isDark: boolean }) {
  return (
    <View className="px-4 pb-2">
      <GlassView
        isInteractive
        style={{
          borderRadius: 18,
          borderCurve: "continuous",
          backgroundColor: isDark
            ? "rgba(28,28,30,0.55)"
            : "rgba(255,255,255,0.55)",
        }}
      >
        <View className="flex-row items-center gap-2 px-4 h-10">
          <Text className="text-sm text-zinc-500 dark:text-zinc-400">
            sidecode
          </Text>
          <Text className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            main
          </Text>
          <View className="flex-1" />
          <Text className="text-sm font-medium text-green-600 dark:text-green-500">
            +12
          </Text>
          <Text className="text-sm font-medium text-red-600 dark:text-red-500">
            -3
          </Text>
        </View>
      </GlassView>
    </View>
  );
}

const MOCK_COMMANDS = [
  { name: "model", description: "Switch the active model" },
  { name: "clear", description: "Archive this session, start a fresh one" },
  { name: "new", description: "Same as /clear" },
  { name: "help", description: "List sidecode-supported slash commands" },
  { name: "compact", description: "(auto-only — sidecode can't trigger)" },
];
