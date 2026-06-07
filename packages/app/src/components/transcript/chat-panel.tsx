import {
  KeyboardAwareLegendList,
  useKeyboardChatComposerInset,
  useKeyboardScrollToEnd,
} from "@legendapp/list/keyboard";
import type { LegendListRef } from "@legendapp/list/react-native";
import type { ImageAttachment } from "@sidecodeapp/protocol";
import {
  type Collection,
  eq,
  useLiveQuery,
  useLiveQueryEffect,
} from "@tanstack/react-db";
import { useQueryClient } from "@tanstack/react-query";
import * as Crypto from "expo-crypto";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useColorScheme, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GitStatusBar } from "@/components/transcript/git-status-bar";
import { InputBar } from "@/components/transcript/input-bar";
import { TextBlock } from "@/components/transcript/text-block";
import { ThinkingIndicator } from "@/components/transcript/thinking-indicator";
import { ToolBlock } from "@/components/transcript/tool-block";
import { useToolCallSheet } from "@/components/transcript/tool-call-sheet";
import { haptics } from "@/lib/haptics";
import { sessionStateCollection } from "@/lib/sessions-collection";
import type { RenderBlock } from "@/lib/transcript-blocks";
import {
  type OrderedTimelineItem,
  sendUserMessage,
} from "@/lib/transcript-collection-factory";

type ChatPanelProps = {
  cliSessionId: string;
  cwd: string | undefined;
  blocks: RenderBlock[];
  /** The raw per-session transcript collection (from useSessionTranscript).
   *  Threaded in rather than re-derived via the factory so the onEnter
   *  haptics effect runs over the exact instance the screen already
   *  subscribed — same object, no second cache lookup. */
  collection: Collection<OrderedTimelineItem, string>;
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
 *   2. The composer-inset SharedValue (via `useKeyboardChatComposerInset`) is
 *      seeded with a deliberate near-miss of the measured composer height — not
 *      0, not the exact value; see the call site for why.
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
 *   4. The list's `keyboardOffset` mirrors `KeyboardStickyView.offset.opened`
 *      (both `insets.bottom - 8`): with the keyboard up it drops the
 *      safe-area band baked into the inset (via the composer's `pb-safe`)
 *      and leaves the last message ~8pt above the keyboard top. Without it
 *      the last message sits a touch low above the composer.
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
  collection,
}: ChatPanelProps) {
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const listRef = useRef<LegendListRef>(null);
  const composerRef = useRef<View>(null);
  const isDark = useColorScheme() === "dark";
  // Tap the workspace status bar → open the working-tree diff in the shared
  // sheet (the provider wraps this screen, see session/[cliSessionId].tsx).
  const { openGitDiff } = useToolCallSheet();
  // Git changes → invalidate the diff query so an OPEN diff sheet refetches
  // (no-op while closed → query inactive). Wired through GitStatusBar's
  // onStatusChange (the single gitStatus subscriber) rather than re-subscribing.
  const queryClient = useQueryClient();
  // Composer → list bottom-inset wiring (library hook). Reports the composer
  // wrapper's measured height (GitStatusBar + InputBar) as the list's bottom
  // inset, both via the `contentInsetEndAdjustment` SharedValue (drives KCSV's
  // visual padding) and an imperative `reportContentInset` (drives LegendList
  // virtualization). No manual `+ insets.bottom`: the composer owns its
  // safe-area band via `pb-safe`, so its measured height already includes it.
  // 180 is a deliberate near-miss of the measured composer height: close enough
  // that initialScrollAtEnd's bootstrap converges in its frame budget, but ≠ the
  // exact value and ≠ 0. An exact seed makes the post-measure inset delta zero →
  // the bootstrap retarget AND KCSV's useAnimatedReaction both no-op (convergence-
  // bounds abort + inset lost on session switch-back); 0 is the other extreme —
  // its delta is too large to converge in budget.
  const { contentInsetEndAdjustment, onComposerLayout } =
    useKeyboardChatComposerInset(listRef, composerRef, 180);

  // Idiomatic scroll-on-send (LegendList chat pattern). `scrollMessageToEnd`
  // brings the just-sent message into view no matter where the user had
  // scrolled to; `freeze` (passed to the list) suspends maintainScrollAtEnd /
  // maintainVisibleContentPosition during the animation so they don't fight it.
  const { freeze, scrollMessageToEnd } = useKeyboardScrollToEnd({ listRef });

  // isThinking: the turn is running (daemon-pushed activity, #17) but the last
  // block isn't Claude's text yet — the initial think window + tool gaps. Drives
  // the resident footer.
  const { data: sessionRow } = useLiveQuery(
    (q) =>
      q
        .from({ s: sessionStateCollection })
        .where(({ s }) => eq(s.cliSessionId, cliSessionId))
        .findOne(),
    [cliSessionId],
  );
  const isRunning = sessionRow?.activity === "running";
  const lastBlock = blocks[blocks.length - 1];
  const isThinking =
    isRunning &&
    !(lastBlock?.kind === "text" && lastBlock.role === "assistant");

  // Message haptics, driven from the on-screen ChatPanel (not the collection
  // sync, which can run off-screen within gcTime and buzz a session you're not
  // in). skipInitial mutes the open-backlog; a reconnect re-ingests as one batch
  // so unchanged rows are updates, not re-enters. Per message that enters:
  // user_message → send, assistant_message → genStart (each agent segment buzzes).
  useLiveQueryEffect<OrderedTimelineItem>(
    {
      query: (q) => q.from({ t: collection }),
      skipInitial: true,
      onEnter: (e) => {
        if (e.value.type === "user_message") haptics.send();
        if (e.value.type === "assistant_message") haptics.genStart();
      },
    },
    [collection],
  );

  // genEnd on the turn ending — not a transcript delta, so it tracks the
  // daemon-pushed activity flag going running→idle. Transition-guarded: fires
  // once, and never on unmount (navigating away mid-turn stays quiet).
  const prevRunning = useRef(false);
  useEffect(() => {
    if (prevRunning.current && !isRunning) haptics.genEnd();
    prevRunning.current = isRunning;
  }, [isRunning]);

  // anchoredEndSpace anchor for the just-sent message: the streaming reply fills
  // reserved space below it instead of shoving the scroll target (overshoot fix).
  // Set in rawSend at send time (the activity flag lags a round-trip); cleared
  // when the turn goes idle.
  const [anchorIndex, setAnchorIndex] = useState(-1);
  useEffect(() => {
    if (!isRunning) setAnchorIndex(-1);
  }, [isRunning]);

  // The "real send" handed to InputBar. InputBar already intercepts slash
  // commands; only plain text + whitelisted passthroughs (/init, /review,
  // /compact) reach here.
  const rawSend = useCallback(
    (text: string, images: ImageAttachment[] | undefined, model: string) => {
      // Optimistic insert (instant paint) + sendPrompt under one client uuid the
      // daemon reuses, so the synced row dedupes by key. cwd/model ride along for
      // --resume project-key resolution and the daemon-restart respawn seed.
      const userMessageUuid = Crypto.randomUUID();
      void sendUserMessage({
        cliSessionId,
        userMessageUuid,
        text,
        cwd,
        images,
        model,
      }).isPersisted.promise.catch((err) => {
        console.error("sendPrompt failed", err);
      });
      // Anchor the new message, then scroll to it next frame (after the optimistic
      // insert reflows). closeKeyboard:false — dismissing mid-scroll fights the
      // scroll target.
      setAnchorIndex(blocks.length);
      requestAnimationFrame(() => {
        void scrollMessageToEnd({ animated: true, closeKeyboard: false });
      });
    },
    [cliSessionId, cwd, blocks.length, scrollMessageToEnd],
  );

  // No first-send-after-create effect here anymore: the new-session
  // screen fires the first sendPrompt itself via `createSession` (the
  // daemon seeds an empty settled snapshot for the new query, so that
  // pre-subscribe send is race-free — see index.tsx). ChatPanel only
  // owns subsequent in-session sends (rawSend above).

  return (
    <>
      <KeyboardAwareLegendList<RenderBlock>
        ref={listRef}
        // Suspends maintainScrollAtEnd / maintainVisibleContentPosition while
        // `scrollMessageToEnd` animates on send, so the chat-pattern scroll
        // isn't fought by the resting scroll managers (LegendList chat guide).
        freeze={freeze}
        // Reserve blank space below the just-sent user message for its turn so
        // the streaming response fills it without moving the anchor (fixes the
        // scroll overshoot). Undefined when idle → normal layout.
        anchoredEndSpace={
          anchorIndex >= 0
            ? { anchorIndex, anchorOffset: headerHeight }
            : undefined
        }
        data={blocks}
        keyExtractor={(b) => b.id}
        // Resident "Thinking…" footer — always mounted at constant height,
        // `active` just fades the label. Constant footerSize is the point: a
        // mount/unmount changes anchoredEndSpace's contentBelowAnchor without
        // triggering its recompute, which jumped the anchored message. Also
        // doubles as the gap below the last message.
        ListFooterComponent={<ThinkingIndicator active={isThinking} />}
        renderItem={({ item }) => {
          if (item.kind === "text") return <TextBlock block={item} />;
          if (item.kind === "tool") return <ToolBlock block={item} />;
          // `compact_divider` — placeholder renders nothing for this
          // commit. Actual divider component (horizontal line + caption)
          // lands in the next Slice 2 commit alongside the reducer
          // wiring that materializes the item.
          return null;
        }}
        // Manual top inset to clear the transparent Stack.Header.
        // With `contentInsetAdjustmentBehavior="never"` below, iOS no
        // longer auto-pads the top; we have to do it ourselves.
        style={{ paddingTop: headerHeight }}
        // Per-kind type (user / assistant / tool / divider — text split by role
        // since a user bubble and assistant text size very differently) → a
        // running-average size PER type instead of one global average, learned
        // per mount. Steady-state win: once a few rows of a kind measure, the
        // rest land close to real (helps the initialScrollAtEnd reveal converge
        // → fewer "convergence bounds" warns). Also keys the recycle pool so a
        // text row isn't recycled into a tool.
        getItemType={(item) => (item.kind === "text" ? item.role : item.kind)}
        // Disable iOS's automatic contentInset adjustments — they
        // fight KeyboardChatScrollView's own inset management and end
        // up double-counting safe area. Per react-native-keyboard-
        // controller chat-app guide: "Always set these to false when
        // using KeyboardChatScrollView inside virtualized lists."
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustContentInsets={false}
        // Bottom inset = the composer wrapper's measured height (already
        // includes the home-indicator band via the composer's `pb-safe`).
        // Drives KCSV's visual padding *and* LegendList virtualization via
        // the imperative reportContentInset — both wired by the hook above.
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
        // Mirrors `KeyboardStickyView.offset.opened` (both `insets.bottom - 8`).
        // KCSV's `keyboardOffset` (renamed from `offset` in @legendapp/list 3.0.0)
        // is "distance from ScrollView bottom to screen bottom" and, on
        // keyboard-open, "by how much to reduce the keyboard push." We want
        // the list to leave a touch of room above the keyboard matching how
        // composer is lifted (-8pt above keyboard top); `insets.bottom`
        // cancels the safe area already accounted for in
        // `contentInsetEndAdjustment` so it isn't counted twice while open.
        // Without this the last message sits ~insets.bottom too low above
        // composer when the keyboard is shown.
        keyboardOffset={insets.bottom - 8}
        // ChatGPT-style scrolling, NOT Telegram-style:
        //   - initialScrollAtEnd: boot at the latest message on session
        //     re-open. Runs a per-frame rAF ticker that retargets to true
        //     end as items measure and the inset settles (LegendList
        //     retargets the initial scroll after inset changes).
        //   - maintainScrollAtEnd: when user is already pinned at bottom,
        //     new messages keep them pinned; scrolling up disengages.
        //
        // DELIBERATELY OMITTED: `alignItemsAtEnd`. That's a
        // Telegram/iMessage idiom (sparse messages stick to the bottom of
        // the viewport via `flexGrow:1 + justifyContent:flex-end` on the
        // contentContainer). For our
        // ChatGPT layout messages flow top-down from the header, and we
        // got two bugs from enabling it: (1) contentContainer was forced
        // to fill the viewport even with one short message, making the
        // list scrollable into the composer inset zone; (2) the
        // bottom-aligned single message rendered behind the composer
        // backdrop because the alignment didn't account for
        // `contentInsetEndAdjustment`.
        initialScrollAtEnd
        maintainScrollAtEnd={{ animated: true }}
        // v3 migration: stabilize the visible position on size/layout
        // changes (keyboard toggle, streaming item growth) but NOT on data
        // adds — `data:false` hands pin-to-bottom-on-new-message to
        // `maintainScrollAtEnd` above. This is the v3 guide's recommended chat
        // config (and the v3 default); set explicitly to document intent. v2's
        // bare boolean mapped to different defaults.
        maintainVisibleContentPosition={{ size: true, data: false }}
        // iOS pull-down-to-dismiss for the keyboard.
        keyboardDismissMode="interactive"
        recycleItems
        // Only push the list up by the keyboard height when the user
        // is already pinned at the bottom; anywhere else the keyboard
        // floats over the content so what they're reading stays put.
        keyboardLiftBehavior="whenAtEnd"
      />
      {/* InputBar floats over the list so transcript content can scroll
          behind it — Liquid Glass needs content underneath to actually blur.
          The composer sits flush at the screen bottom (no closed offset); its
          own `pb-safe` pads GitStatusBar + InputBar above the home indicator.
          `offset.opened: insets.bottom - 8` — when the keyboard is up it drops
          that now-unneeded safe-area band and leaves the input ~8pt above the
          keyboard top.

          The inner `composerRef` View wraps everything that needs to
          be measured for list bottom-inset — currently GitStatusBar +
          InputBar; future error banners / attachment rows should go
          inside this same wrapper so the list auto-adjusts.
          `collapsable={false}` is required for `measure` / `onLayout`
          to fire reliably on Android. */}
      <KeyboardStickyView
        offset={{ opened: insets.bottom - 8 }}
        style={{ position: "absolute", left: 0, right: 0, bottom: 0 }}
      >
        <View
          ref={composerRef}
          collapsable={false}
          onLayout={onComposerLayout}
          className="pb-safe"
          style={{
            experimental_backgroundImage: isDark
              ? "linear-gradient(to top, rgba(0,0,0,0.8), rgba(0,0,0,0))"
              : "linear-gradient(to top, rgba(255,255,255,0.8), rgba(255,255,255,0))",
          }}
        >
          <GitStatusBar
            cwd={cwd}
            onPress={cwd ? () => openGitDiff(cwd) : undefined}
            onStatusChange={
              cwd
                ? () =>
                    queryClient.invalidateQueries({
                      queryKey: ["workingTreeDiff", cwd],
                    })
                : undefined
            }
          />
          <InputBar cliSessionId={cliSessionId} onSend={rawSend} />
        </View>
      </KeyboardStickyView>
    </>
  );
}
