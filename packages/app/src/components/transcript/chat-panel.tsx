import { KeyboardChatLegendList } from "@legendapp/list/keyboard-chat";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { ImageAttachment } from "@sidecodeapp/protocol";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { type LayoutChangeEvent, View, useColorScheme } from "react-native";
import {
  KeyboardStickyView,
  useReanimatedKeyboardAnimation,
} from "react-native-keyboard-controller";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GitStatusBar } from "@/components/transcript/git-status-bar";
import {
  InputBar,
  type ModelSelection,
} from "@/components/transcript/input-bar";
import { TextBlock } from "@/components/transcript/text-block";
import { ToolBlock } from "@/components/transcript/tool-block";
import { useSlashCommandHandler } from "@/hooks/use-slash-command-handler";
import { useDaemonClient } from "@/lib/daemon-client-context";
import { consumePendingPrompt } from "@/lib/submission-store";
import type { RenderBlock } from "@/lib/transcript-blocks";
import { LinearGradient } from "expo-linear-gradient";

// Animatable wrapper for `LinearGradient` — module-level so the wrapped
// component identity is stable across renders.
const ReanimatedLinearGradient =
  Reanimated.createAnimatedComponent(LinearGradient);

type ChatPanelProps = {
  cliSessionId: string;
  cwd: string | undefined;
  blocks: RenderBlock[];
  isRunning: boolean;
  /** Current picker selection — InputBar is fully controlled. Parent
   *  derives from useSessions cache for resume sessions (with
   *  useSetSessionSelection mutation on change) or local state for
   *  pre-creation new-session flow. */
  selection?: ModelSelection;
  /** Called on user pick; parent commits however it likes (optimistic
   *  cache mutation, local setter, etc.). */
  onSelectionChange?: (next: ModelSelection) => void;
  /** Context-window meter for the model picker. Forwarded as-is to
   *  InputBar — drives both the chip background fill (percentage) and
   *  the picker menu's header (`Context usage: 145k / 200k`). Parent
   *  (SessionDetailScreen) computes via
   *  `useContextUsage(session.latestUsage, selection?.model)`. */
  contextUsage?: { used: number; max: number; percentage: number };
};

/**
 * Chat surface: virtualized transcript list + sticky composer
 * (GitStatusBar + InputBar) above the keyboard, plus the
 * composer-inset wiring that keeps the last message visible above the
 * composer no matter how it grows or the keyboard toggles.
 *
 * Mounted only in the parent's `ready` branch (loading / error
 * render their own placeholders) — the whole chat surface mounts and
 * unmounts as a unit per session. That single boundary fixes a chain
 * of issues we hit while iterating:
 *
 *   1. `initialScrollAtEnd` always sees non-empty data on first
 *      commit. The list relies on a per-frame rAF ticker to retarget
 *      to true end as items measure; that needs non-empty data to
 *      have somewhere to land. (Before: list mounted under
 *      ListEmptyComponent with data=[] during loading, retarget never
 *      fired, last message stayed hidden behind composer until user
 *      toggled keyboard.)
 *
 *   2. The composer-inset SharedValue starts fresh per session, with
 *      initial value 0 (NOT the measured composer height — see the
 *      block comment at `useSharedValue(0)` below for why). The
 *      measure-callback transition 0→real fires KCSV's
 *      `useAnimatedReaction` after the list ref is bound, guaranteeing
 *      the bottom inset propagates. (Before: hook sat on the parent
 *      screen with a stale dedup cache, OR init matched measured so no
 *      transition fired — both left the last message clipped until the
 *      user toggled the keyboard.)
 *
 *   3. KeyboardChatScrollView vs. iOS automatic contentInset
 *      adjustments: must disable both
 *      `contentInsetAdjustmentBehavior` and
 *      `automaticallyAdjustContentInsets`. Per the
 *      react-native-keyboard-controller chat-app guide, iOS's
 *      automatic adjustments double-count safe area against KCSV's
 *      own management. (Before: visible clipping under composer of
 *      ~insets.bottom = the home-indicator zone.) Side effect: iOS
 *      no longer auto-pads the top either, so we manually apply
 *      `style={{ paddingTop: headerHeight }}` to keep content from
 *      starting under the transparent Stack.Header. Both ends become
 *      our responsibility once auto-adjust is off.
 *
 *   4. The list's `offset` prop must mirror
 *      `KeyboardStickyView.offset.opened: -8` (and subtract the
 *      safe area already accounted for in the inset SharedValue) →
 *      `offset={insets.bottom - 8}`. Without this the last message
 *      sits a touch low above composer with the keyboard up.
 *
 * Trade-off: brief no-composer flash during the loading transition
 * (typically <300ms for an in-flight subscribe). Mirror of how
 * Claude Desktop / ChatGPT handle session-switch loading — input is
 * hidden until the session is ready to receive it. The alternative —
 * keeping composer mounted across loading — required ad-hoc fixes
 * for the inset hook state and initialScrollAtEnd that weren't
 * reliable.
 */
export function ChatPanel({
  cliSessionId,
  cwd,
  blocks,
  isRunning,
  selection,
  onSelectionChange,
  contextUsage,
}: ChatPanelProps) {
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { client } = useDaemonClient();
  const listRef = useRef<LegendListRef>(null);
  const composerRef = useRef<View>(null);
  const isDark = useColorScheme() === "dark";
  const { height: keyboardHeightSV } = useReanimatedKeyboardAnimation();
  // Inset pipeline — inlined replacement for `useKeyboardChatComposer-
  // Inset`. We need the list's bottom inset to be `composer height +
  // insets.bottom` (composer measured + home-indicator band, since the
  // composer is shifted UP by `insets.bottom` via
  // KeyboardStickyView.offset.closed). The library hook only reports
  // composer's measured height through its SharedValue + imperative
  // `listRef.current.reportContentInset`, so the bottom safe-area band
  // stays clipped behind the home indicator unless we add insets.bottom
  // ourselves.
  //
  // Why not `useDerivedValue(composerHeight + insets.bottom)` layered
  // over the hook's SharedValue: confirmed via diagnostic logs that
  // KCSV's `extraContentPadding` binding only tracks MUTABLE
  // SharedValues — derived values produce correct .value but don't
  // propagate to the native ScrollView's contentInset (contentLength
  // stayed frozen across composer height changes). So we own the
  // SharedValue directly.
  //
  // The two-channel pattern (write SharedValue + call
  // `reportContentInset`) matches the library hook: SharedValue drives
  // KCSV's visual padding, the imperative call drives LegendList
  // virtualization (anchoredEndSpace, end detection).
  //
  // **Initial value MUST be 0**, not the expected `composer + insets`.
  // KCSV's internal `useAnimatedReaction` fires once on mount with
  // (current=initialValue, previous=undefined) — if listRef isn't bound
  // yet at that moment, the call is lost; and because the value never
  // changes afterward (init matches measured), the reaction never
  // re-fires. Starting at 0 forces a 0→real transition once measure
  // callback lands AFTER listRef is bound. Symptom of getting this
  // wrong: session-switch initial bottom inset failed until user
  // toggled the keyboard. The gradient's `useAnimatedStyle` below
  // shares this SharedValue and benefits from the same forced
  // transition.
  const contentInsetEndAdjustment = useSharedValue(0);

  // Scroll-edge fade gradient — height tracks composer + keyboard so the
  // band always reaches the composer chrome's top; bottom is fixed at
  // screen edge via `bottom: 0` in the JSX style.
  // `keyboardHeightSV.value` is negative when keyboard is open, hence
  // `-value` for the keyboard contribution.
  const animatedGradientStyle = useAnimatedStyle(() => ({
    height: -keyboardHeightSV.value + contentInsetEndAdjustment.value,
  }));

  const reportInset = useCallback(
    (composerPx: number) => {
      const inset = composerPx + insets.bottom;
      if (!Number.isFinite(inset)) {
        return;
      }
      contentInsetEndAdjustment.value = inset;
      listRef.current?.reportContentInset({ bottom: inset });
    },
    [contentInsetEndAdjustment, insets.bottom],
  );

  // Run once after composer mounts in case onLayout fires too late
  // for the list's initial commit. measure() runs after native layout
  // pass, so by the time the callback runs the composer has its real
  // height.
  useLayoutEffect(() => {
    composerRef.current?.measure((_x, _y, _w, h) => reportInset(h));
  }, [reportInset]);

  const onComposerLayout = useCallback(
    (e: LayoutChangeEvent) => reportInset(e.nativeEvent.layout.height),
    [reportInset],
  );

  // Raw sendPrompt — invoked for non-slash text AND for whitelisted
  // passthrough commands (/init, /review, /compact). Intercept-handling
  // commands (/clear, /model) never reach here — `useSlashCommandHandler`
  // dispatches them locally instead. See the hook's file header.
  const rawSend = useCallback(
    (text: string, images?: ImageAttachment[]) => {
      if (!client) return;
      // cwd is required for the SDK's project-key resolution on
      // `--resume`. For sessions opened from the list, cwd is plumbed
      // through route params; deeplink / direct nav (V0.5+) will need
      // a fallback fetch.
      //
      // `model` is still attached on every send so the daemon's
      // ensureSessionLoop has it as SDK initial option on first spawn
      // (or after a daemon-restart respawn). Mid-session apply is
      // owned by setSessionSelection — sendPrompt only seeds.
      void client
        .sendPrompt({
          sessionId: cliSessionId,
          text,
          cwd,
          images,
          model: selection?.model,
        })
        .catch((err) => {
          console.error("sendPrompt failed", err);
        });
    },
    [client, cliSessionId, cwd, selection],
  );

  const onSend = useSlashCommandHandler({
    context: "in-session",
    sessionId: cliSessionId,
    onPassthrough: rawSend,
  });

  const onInterrupt = useCallback(() => {
    if (!client) return;
    void client.interrupt(cliSessionId).catch((err) => {
      console.error("interrupt failed", err);
    });
  }, [client, cliSessionId]);

  // First-send-after-create flow. The new-session screen stashed
  // `{ text, cwd }` in the submission store before navigating; we
  // consume + send here. Critical timing: this effect must run AFTER
  // `useLiveSession` has finished its initial subscribe, so the
  // daemon's live fanout callback is already registered before
  // sendPrompt runs (otherwise the synthesized user_message +
  // turn_started events fall into the cursor race window).
  //
  // ChatPanel only mounts in the parent's `ready` branch — i.e. after
  // `isInitialLoading` flips false, i.e. after subscribe resolved. So
  // ChatPanel mount = race window closed. The previous version sat in
  // SessionDetailScreen and had to gate on `isInitialLoading` in its
  // deps; here that gate is structural — no dep needed.
  //
  // sentInitialRef ensures exactly-once even if `client` identity
  // churns mid-mount; `consumePendingPrompt` clears its Map entry on
  // first read so a subsequent ChatPanel remount (different session)
  // also won't double-fire.
  const sentInitialRef = useRef(false);
  useEffect(() => {
    if (sentInitialRef.current) return;
    if (!client) return;
    const pending = consumePendingPrompt(cliSessionId);
    if (!pending) return;
    sentInitialRef.current = true;
    void client
      .sendPrompt({
        sessionId: cliSessionId,
        text: pending.text,
        cwd: pending.cwd,
        images: pending.images,
        model: pending.model,
      })
      .catch((err) => {
        console.error("initial sendPrompt failed", err);
      });
  }, [client, cliSessionId]);

  return (
    <>
      <KeyboardChatLegendList<RenderBlock>
        ref={listRef}
        data={blocks}
        keyExtractor={(b) => b.id}
        renderItem={({ item }) => {
          if (item.kind === "text") return <TextBlock block={item} />;
          if (item.kind === "tool") return <ToolBlock block={item} />;
          // `compact_divider` + `compact_summary` — placeholders render
          // nothing for this commit. Actual components (divider chip +
          // tappable summary row that opens the shared transcript sheet)
          // land in the next Slice 2 commits alongside the reducer
          // wiring + sheet generalization.
          return null;
        }}
        // Manual top inset to clear the transparent Stack.Header.
        // With `contentInsetAdjustmentBehavior="never"` below, iOS no
        // longer auto-pads the top; we have to do it ourselves.
        style={{ paddingTop: headerHeight }}
        // Mixed-block heuristic: short user bubble ~60pt, assistant
        // text ~100pt, tool block ~50pt (sheet-on-tap, no inline
        // expanded content). ~80 is a defensible average; the list
        // re-measures actual sizes after first render.
        estimatedItemSize={80}
        // Disable iOS's automatic contentInset adjustments — they
        // fight KeyboardChatScrollView's own inset management and end
        // up double-counting safe area. Per react-native-keyboard-
        // controller chat-app guide: "Always set these to false when
        // using KeyboardChatScrollView inside virtualized lists."
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        // Bottom inset = composer measured height + insets.bottom
        // (see SharedValue setup above). Drives KCSV's visual padding
        // *and* LegendList virtualization via the imperative
        // reportContentInset call.
        contentInsetEndAdjustment={contentInsetEndAdjustment}
        // Workaround for facebook/react-native#54123 — on iOS + RN
        // ≥0.81, the `contentInset` area created by extraContentPadding
        // doesn't respond to touch/scroll. This swizzles UIScrollView's
        // hit-test container at runtime; KCSV docs warn it's fragile,
        // accepted as the price of having a tappable composer band
        // until the upstream fix ships. RN issue closed 2026-05-12,
        // should land in 0.86/0.87 — DELETE this prop after upgrading
        // and verifying scroll/tap in the inset zone.
        applyWorkaroundForContentInsetHitTestBug
        // Mirrors `KeyboardStickyView.offset.opened: -8`. KCSV's
        // `offset` is "distance from ScrollView bottom to screen
        // bottom" and, on keyboard-open, "by how much to reduce the
        // keyboard push." We want the list to leave a touch of room
        // above the keyboard matching how composer is lifted (-8pt
        // above keyboard top); `insets.bottom` cancels the safe area
        // already accounted for in `contentInsetEndAdjustment` so it
        // isn't counted twice while open. Without this the last
        // message sits ~insets.bottom too low above composer when the
        // keyboard is shown.
        offset={insets.bottom - 8}
        // ChatGPT-style scrolling, NOT Telegram-style:
        //   - initialScrollAtEnd: boot at the latest message on session
        //     re-open. Runs a per-frame rAF ticker that retargets to true
        //     end as items measure and the inset settles (LegendList
        //     beta.54 "retarget initial scroll after inset changes").
        //   - maintainScrollAtEnd: when user is already pinned at bottom,
        //     new messages keep them pinned; scrolling up disengages.
        //
        // DELIBERATELY OMITTED: `alignItemsAtEnd`. That's a
        // Telegram/iMessage idiom (sparse messages stick to the bottom of
        // the viewport via `flexGrow:1 + justifyContent:flex-end` on the
        // contentContainer, see @legendapp/list/react.js:6611). For our
        // ChatGPT layout messages flow top-down from the header, and we
        // got two bugs from enabling it: (1) contentContainer was forced
        // to fill the viewport even with one short message, making the
        // list scrollable into the composer inset zone; (2) the
        // bottom-aligned single message rendered behind the composer
        // backdrop because the alignment didn't account for
        // `contentInsetEndAdjustment`.
        initialScrollAtEnd
        maintainScrollAtEnd={{ animated: true }}
        // Keep already-visible content's absolute position stable
        // when new items arrive or the keyboard toggles — the
        // Telegram/iMessage "what I'm reading doesn't jump" behavior.
        maintainVisibleContentPosition
        // iOS pull-down-to-dismiss for the keyboard.
        keyboardDismissMode="interactive"
        recycleItems
        // Only push the list up by the keyboard height when the user
        // is already pinned at the bottom; anywhere else the keyboard
        // floats over the content so what they're reading stays put.
        keyboardLiftBehavior="whenAtEnd"
      />
      {/* Scroll-edge fade — ChatGPT/Claude-style. Sits as a SIBLING of
          the KSV (page coords), so `bottom: 0` is the screen edge
          directly. Rendered BEFORE the KSV → lower in z-order; the
          composer chrome's translucent backdrop blur sits on top, but
          the opaque-at-bottom gradient shows through it and through
          home-indicator / keyboard regions — transcript content
          "dissolves" into the page bg as it scrolls toward composer.

          Height = `-keyboardHeightSV + contentInsetEndAdjustment` —
          shares the inset SharedValue, so it transitions 0→real on the
          same measure callback (see init=0 explanation above). When
          the keyboard opens, gradient extends into the keyboard
          region (no hairline gap between chrome and keyboard top). */}
      <ReanimatedLinearGradient
        colors={
          isDark
            ? ["rgba(0,0,0,0)", "rgba(0,0,0,1)"]
            : ["rgba(255,255,255,0)", "rgba(255,255,255,1)"]
        }
        pointerEvents="none"
        style={[
          { position: "absolute", left: 0, right: 0, bottom: 0 },
          animatedGradientStyle,
        ]}
      />
      {/* InputBar floats over the list so transcript content can
          scroll behind it — Liquid Glass needs content underneath to
          actually blur. KeyboardStickyView's translateY math:
          `height.value + offset(progress)`; offset closed: -insets.bottom
          clears the home indicator, opened: -8 lifts a touch above
          the keyboard top.

          The inner `composerRef` View wraps everything that needs to
          be measured for list bottom-inset — currently GitStatusBar +
          InputBar; future error banners / attachment rows should go
          inside this same wrapper so the list auto-adjusts.
          `collapsable={false}` is required for `measure` / `onLayout`
          to fire reliably on Android. */}
      <KeyboardStickyView
        offset={{ closed: -insets.bottom, opened: -8 }}
        style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
      >
        <View ref={composerRef} collapsable={false} onLayout={onComposerLayout}>
          <GitStatusBar cwd={cwd} />
          <InputBar
            onSend={onSend}
            onInterrupt={onInterrupt}
            isRunning={isRunning}
            selection={selection}
            onSelectionChange={onSelectionChange}
            slashContext="in-session"
            contextUsage={contextUsage}
          />
        </View>
      </KeyboardStickyView>
    </>
  );
}
