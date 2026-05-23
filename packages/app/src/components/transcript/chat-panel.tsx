import { KeyboardChatLegendList } from "@legendapp/list/keyboard-chat";
import type { LegendListRef } from "@legendapp/list/react-native";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { type LayoutChangeEvent, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSharedValue } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GitStatusBar } from "@/components/transcript/git-status-bar";
import { InputBar } from "@/components/transcript/input-bar";
import { TextBlock } from "@/components/transcript/text-block";
import { ToolBlock } from "@/components/transcript/tool-block";
import { useDaemonClient } from "@/lib/daemon-client-context";
import { consumePendingPrompt } from "@/lib/submission-store";
import type { RenderBlock } from "@/lib/transcript-blocks";

const INITIAL_COMPOSER_HEIGHT = 147;

type ChatPanelProps = {
  cliSessionId: string;
  cwd: string | undefined;
  blocks: RenderBlock[];
  isRunning: boolean;
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
 *   2. The composer-inset SharedValue + the imperative
 *      `reportContentInset` call both start clean on each session
 *      switch — no stale "last reported height" cache surviving
 *      across sessions. (Before: when the inset hook sat on the
 *      parent screen, its value-dedup cache outlived the list and
 *      suppressed re-priming against a fresh list instance, leaving
 *      the last message clipped until keyboard toggle.)
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
}: ChatPanelProps) {
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const { client } = useDaemonClient();
  const listRef = useRef<LegendListRef>(null);
  const composerRef = useRef<View>(null);
  // Inset pipeline — inlined replacement for `useKeyboardChatComposer-
  // Inset`. The library hook reports only composer's measured height
  // through its SharedValue *and* its imperative
  // `listRef.current.reportContentInset` call, so the list ends up
  // reserving exactly `composer height` and the last
  // `insets.bottom` pixels of content stay hidden behind the home
  // indicator (composer is shifted UP by `insets.bottom` via
  // KeyboardStickyView.offset.closed). We need the inset to be
  // `composer height + insets.bottom`.
  //
  // Why not `useDerivedValue(composerHeight.value + insets.bottom)`
  // over the hook's SharedValue: confirmed via diagnostic logs that
  // KeyboardChatScrollView's `extraContentPadding` binding only
  // tracks mutable SharedValues — derived values produce correct
  // .value but don't propagate to the native ScrollView's contentInset
  // (contentLength stayed frozen across composer height changes).
  // So we own the SharedValue and write to it directly.
  //
  // The two-channel pattern (write SharedValue + call
  // `reportContentInset`) matches the library hook: SharedValue
  // drives KCSV's visual padding, the imperative call drives the
  // LegendList virtualization (anchoredEndSpace, end detection).
  // Both must be kept in sync — that's why the report is gated by
  // `lastReportedInsetRef` to dedupe.
  const contentInsetEndAdjustment = useSharedValue(
    INITIAL_COMPOSER_HEIGHT + insets.bottom,
  );
  const lastReportedInsetRef = useRef<number | undefined>(undefined);

  const reportInset = useCallback(
    (composerPx: number) => {
      const inset = composerPx + insets.bottom;
      if (!Number.isFinite(inset) || inset === lastReportedInsetRef.current) {
        return;
      }
      lastReportedInsetRef.current = inset;
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

  const onSend = useCallback(
    (text: string) => {
      if (!client) return;
      // cwd is required for the SDK's project-key resolution on
      // `--resume`. For sessions opened from the list, cwd is plumbed
      // through route params; deeplink / direct nav (V0.5+) will need
      // a fallback fetch.
      void client.sendPrompt(cliSessionId, text, cwd).catch((err) => {
        console.error("sendPrompt failed", err);
      });
    },
    [client, cliSessionId, cwd],
  );

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
      .sendPrompt(cliSessionId, pending.text, pending.cwd)
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
        renderItem={({ item }) =>
          item.kind === "text" ? (
            <TextBlock block={item} />
          ) : (
            <ToolBlock block={item} />
          )
        }
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
        // Chat-mode triple: boot at the latest message
        // (initialScrollAtEnd — runs a per-frame rAF ticker that
        // retargets to true end as items measure and the inset
        // settles, see beta.54 "retarget initial scroll after inset
        // changes"), stick content to bottom when smaller than view
        // (alignItemsAtEnd), keep viewport pinned to bottom when user
        // is already near it (maintainScrollAtEnd). User scrolling up
        // disengages the pin.
        initialScrollAtEnd
        alignItemsAtEnd
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
          />
        </View>
      </KeyboardStickyView>
    </>
  );
}
