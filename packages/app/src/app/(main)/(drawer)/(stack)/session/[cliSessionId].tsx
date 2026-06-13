import { eq, useLiveQuery } from "@tanstack/react-db";
import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo } from "react";
import { Text, View } from "react-native";
import { SessionBridgeToolbar } from "@/components/session-bridge-toolbar";
import { ChatPanel } from "@/components/transcript/chat-panel";
import { TranscriptLoading } from "@/components/transcript/transcript-loading";
import { useSessionTranscript } from "@/hooks/use-session-transcript";
import { useDrawerUI } from "@/lib/drawer-ui";
import { sessionStateCollection } from "@/lib/sessions-collection";
import { flattenToBlocks } from "@/lib/transcript-blocks";

/**
 * Detail route. Renders the transcript flattened into per-content-block
 * rows (text + tool) with role attribution managed by a speaker state
 * machine (see flattenToBlocks).
 *
 * Route: /session/<cliSessionId>
 *  - cliSessionId: path slug — the canonical conversation identity
 *  - header title comes from the session's row in the sessions collection
 *    (filtered live query below), NOT a route param — so it stays correct
 *    as the daemon's canonical title lands; falls back to "Session" until
 *    the row is available (e.g. cold deeplink before the list syncs)
 *
 * Live: this screen owns the session subscription (`useSessionTranscript`)
 * and the loading / error / ready branching. The ready branch hands
 * off to <ChatPanel/>, which owns everything chat-surface — the
 * virtualized list, the sticky composer, the composer-inset pipeline,
 * and in-session sendPrompt / interrupt wiring. (The FIRST send for a new
 * session fires from the new-session screen via `createSession`, not
 * here.) That split keeps `useDaemonClient` out of this file entirely:
 * imperative daemon calls live next to the UI that triggers them.
 *
 * Why ChatPanel is a separate component rather than inlined here:
 * mounting ChatPanel only in the ready branch makes the chat
 * surface's lifecycle == session-ready lifecycle. The hook for
 * composer inset measurement, the LegendList's `initialScrollAtEnd`
 * commit, and the daemon's live fanout registration all start from a
 * clean state on each session switch — no cross-mount cache
 * surviving between sessions. See chat-panel.tsx for the longer
 * story.
 */
export default function SessionDetailScreen() {
  const {
    cliSessionId,
    cwd,
    new: newFlag,
  } = useLocalSearchParams<{
    cliSessionId: string;
    cwd?: string;
    // `?new=1` — set only by the new-session screen's router.replace on a
    // session it just created. Tells the transcript subscribe to take the
    // daemon's no-disk-scan fast path (see subscribeCommand.isNew). Safe
    // not to clear: every navigation here is a `router.replace` that
    // respecifies params, so re-entering an existing session never
    // carries it, and cold launch lands on `/` — so a stale `new=1` can't
    // reach a second collection creation.
    new?: string;
  }>();
  const session = useSessionTranscript(cliSessionId, newFlag === "1");

  // Drawer-settle gate. Mounting ChatPanel is heavy on the MAIN thread
  // (native view inflation + enriched's dispatch_sync measure), which the
  // drawer-close animation (Reanimated, UI thread) directly competes with —
  // JS fps can look fine while the close visibly stutters. A sidebar tap
  // flips `closing` (in closeDrawer) in the same batch as the route swap, so
  // the session being navigated TO mounts with `closing === true` and shows
  // the cheap TranscriptLoading; ChatPanel mounts once the close lands
  // (onTransitionEnd clears `closing`). Every other entry path — deep link,
  // new-session replace, the drawer merely opening over an already-settled
  // session — has `closing === false`. Because `closing` is scoped to
  // navigation-coupled closes (see drawer-ui.tsx) it never flips true under a
  // mounted session, so the gate is just a derived boolean: no state, no
  // effect, no per-session keying.
  const { closing, openDrawer } = useDrawerUI();
  const drawerSettled = !closing;

  // Log turn-failure errors. UI is intentionally absent for V0 —
  // surfacing assistant errors well needs design work we haven't done
  // (toast vs. inline bubble vs. retry CTA). Until then keep dev
  // visibility via console.error.
  useEffect(() => {
    if (session.lastError) {
      console.error("[session] turn failed:", session.lastError);
    }
  }, [session.lastError]);

  const blocks = useMemo(() => flattenToBlocks(session.items), [session.items]);

  // Read THIS session's row from the collection with a filtered live query
  // (findOne on cliSessionId) — just for the header title. The model
  // picker / context meter / running state are owned by InputBar now (it
  // self-sources from `cliSessionId`), so this screen no longer derives
  // selection or contextUsage. The row is present at mount because the
  // new-session screen inserts it optimistically before navigating
  // (resume sessions already have it from the #17 subscribeSessions
  // snapshot).
  const { data: sessionInfo } = useLiveQuery(
    (q) =>
      q
        .from({ s: sessionStateCollection })
        .where(({ s }) => eq(s.cliSessionId, cliSessionId))
        .findOne(),
    [cliSessionId],
  );

  return (
    <>
      {/* Title via Stack.Screen options. Header chrome (transparent +
          Liquid Glass blur) and the hamburger button via the new SDK 56
          Stack.Header / Stack.Toolbar APIs — these render natively
          (UIKit UINavigationBar), so the system handles blur strength
          tracking with scroll, dynamic-type sizing, RTL, etc. */}
      <Stack.Screen options={{ title: sessionInfo?.title || "Session" }} />
      <Stack.Header transparent />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="line.3.horizontal" onPress={openDrawer} />
      </Stack.Toolbar>
      {/* Trailing bridge toggle (cloud ↔ cloud.fill). Own component so
          this screen stays free of useDaemonClient (see header note). */}
      <SessionBridgeToolbar cliSessionId={cliSessionId} />
      {/* ToolCallSheetProvider lives in (stack)/_layout.tsx so its resident
          webview + worker pool are shared across session switches. */}
      <View className="flex-1 bg-white dark:bg-black">
        {session.isInitialLoading || !drawerSettled ? (
          <TranscriptLoading />
        ) : session.error ? (
          <View className="flex-1 items-center justify-center px-6">
            <Text className="text-center text-base font-medium text-red-600 dark:text-red-400">
              Couldn't load messages
            </Text>
            <Text className="mt-2 text-center text-xs text-gray-500 dark:text-gray-400">
              {session.error.message}
            </Text>
          </View>
        ) : (
          <ChatPanel
            cliSessionId={cliSessionId}
            cwd={cwd}
            blocks={blocks}
            collection={session.collection}
          />
        )}
      </View>
    </>
  );
}
