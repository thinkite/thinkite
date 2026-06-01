import { DEFAULT_MODEL } from "@sidecodeapp/protocol";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { DrawerActions } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { ChatPanel } from "@/components/transcript/chat-panel";
import { ToolCallSheetProvider } from "@/components/transcript/tool-call-sheet";
import { useContextUsage } from "@/hooks/use-context-usage";
import { useSessionTranscript } from "@/hooks/use-session-transcript";
import { useSetSessionSelection } from "@/hooks/use-set-session-selection";
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
  const { cliSessionId, cwd } = useLocalSearchParams<{
    cliSessionId: string;
    cwd?: string;
  }>();
  const session = useSessionTranscript(cliSessionId);
  const navigation = useNavigation();

  // Log turn-failure errors. UI is intentionally absent for V0 —
  // surfacing assistant errors well needs design work we haven't done
  // (toast vs. inline bubble vs. retry CTA). Until then keep dev
  // visibility via console.error.
  useEffect(() => {
    if (session.lastError) {
      console.error("[session] turn failed:", session.lastError);
    }
  }, [session.lastError]);

  const openDrawer = useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer());
  }, [navigation]);

  const blocks = useMemo(() => flattenToBlocks(session.items), [session.items]);

  // Read THIS session's row from the collection with a filtered live query
  // (findOne on cliSessionId) — not the whole list. Drives the header
  // title and the picker's current model. The row is present at mount
  // because the new-session screen inserts it optimistically before
  // navigating (resume sessions already have it from listSessions).
  const { data: sessionInfo } = useLiveQuery(
    (q) =>
      q
        .from({ s: sessionStateCollection })
        .where(({ s }) => eq(s.cliSessionId, cliSessionId))
        .findOne(),
    [cliSessionId],
  );

  // Picker selection comes from the row's `model`; useSetSessionSelection
  // updates the collection optimistically on pick + fires the daemon RPC,
  // with automatic rollback on failure. Sessions with no model on disk
  // fall back to the bundled `DEFAULT_MODEL` until the user picks. The
  // fallback is synchronous (DEFAULT_MODEL is a module constant) so
  // there's no "models loading" race — selection is always defined.
  const setSelection = useSetSessionSelection(cliSessionId);
  const selection = useMemo(() => {
    if (sessionInfo?.model) return { model: sessionInfo.model };
    return { model: DEFAULT_MODEL.model };
  }, [sessionInfo?.model]);

  // [sidecode/model-bug] LOG E — what the detail screen actually
  // displays. Fires on every render where sessionInfo or selection
  // changes. If sessionInfo.model is Sonnet but selection is Opus,
  // the useMemo is broken. If sessionInfo.model is null/undefined, the
  // sync push didn't land (or landed with model=null).
  // biome-ignore lint/correctness/useExhaustiveDependencies: diagnostic
  useEffect(() => {
    console.log("[sidecode/model-bug] E detail render", {
      sid: cliSessionId,
      sessionInfoModel: sessionInfo?.model,
      selectionModel: selection.model,
      hasSessionInfo: sessionInfo !== undefined,
    });
  }, [sessionInfo?.model, selection.model]);

  // Context-window meter for the model picker chip. Joins the latest
  // turn_completed.usage (from useSessionTranscript) with the selected
  // model's contextWindow (from the bundled MODEL_METADATA table).
  // Returns null when no turn has completed yet — InputBar then renders
  // the chip with no fill.
  const contextUsage = useContextUsage(session.latestUsage, selection?.model);

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
      <ToolCallSheetProvider>
        <View className="flex-1 bg-white dark:bg-black">
          {session.isInitialLoading ? (
            <View className="flex-1 items-center justify-center">
              <ActivityIndicator />
            </View>
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
              isRunning={session.isRunning}
              selection={selection}
              onSelectionChange={setSelection.mutate}
              contextUsage={contextUsage ?? undefined}
            />
          )}
        </View>
      </ToolCallSheetProvider>
    </>
  );
}
