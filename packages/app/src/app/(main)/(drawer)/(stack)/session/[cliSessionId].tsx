import { Stack, useLocalSearchParams, useNavigation } from "expo-router";
import { DrawerActions } from "expo-router/react-navigation";
import { useCallback, useEffect, useMemo } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { ChatPanel } from "@/components/transcript/chat-panel";
import { ToolCallSheetProvider } from "@/components/transcript/tool-call-sheet";
import { useContextUsage } from "@/hooks/use-context-usage";
import { useLiveSession } from "@/hooks/use-live-session";
import { useModels } from "@/hooks/use-models";
import { useSessions } from "@/hooks/use-sessions";
import { useSetSessionSelection } from "@/hooks/use-set-session-selection";
import { flattenToBlocks } from "@/lib/transcript-blocks";

/**
 * Detail route. Renders the transcript flattened into per-content-block
 * rows (text + tool) with role attribution managed by a speaker state
 * machine (see flattenToBlocks).
 *
 * Route: /session/<cliSessionId>?title=<encoded>
 *  - cliSessionId: path slug — the canonical conversation identity
 *  - title: query — header label; falls back to "Session" for deeplink
 *    navigations (V0.5+) where the caller didn't have one
 *
 * Live: this screen owns the session subscription (`useLiveSession`)
 * and the loading / error / ready branching. The ready branch hands
 * off to <ChatPanel/>, which owns everything chat-surface — the
 * virtualized list, the sticky composer, the composer-inset pipeline,
 * sendPrompt / interrupt wiring, and the first-send-after-create
 * effect. That split keeps `useDaemonClient` out of this file
 * entirely: imperative daemon calls live next to the UI that
 * triggers them.
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
  const { cliSessionId, title, cwd } = useLocalSearchParams<{
    cliSessionId: string;
    title?: string;
    cwd?: string;
  }>();
  const session = useLiveSession(cliSessionId);
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

  // Picker selection is fully driven by the useSessions cache — the
  // SessionInfo row for this cliSessionId carries `model`.
  // useSetSessionSelection mutates the cache optimistically on pick +
  // fires the daemon RPC; rollback is automatic on RPC failure.
  //
  // Pre-feature sessions (no model on disk yet) fall back to the
  // daemon's default model. Once the user picks anything the mutation
  // writes the real entry, and the fallback drops out.
  const { data: sessions } = useSessions();
  const { data: models } = useModels();
  const setSelection = useSetSessionSelection(cliSessionId);
  const selection = useMemo(() => {
    const entry = sessions?.find((s) => s.cliSessionId === cliSessionId);
    if (entry?.model) {
      return { model: entry.model };
    }
    const def = models?.find((m) => m.isDefault) ?? models?.[0];
    if (def) return { model: def.model };
    return undefined;
  }, [sessions, cliSessionId, models]);

  // Context-window meter for the model picker chip. Joins the latest
  // turn_completed.usage (from useLiveSession) with the selected
  // model's contextWindow (from useModels). Returns null until both are
  // ready — InputBar then renders the chip with no fill.
  const contextUsage = useContextUsage(session.latestUsage, selection?.model);

  return (
    <>
      {/* Title via Stack.Screen options. Header chrome (transparent +
          Liquid Glass blur) and the hamburger button via the new SDK 56
          Stack.Header / Stack.Toolbar APIs — these render natively
          (UIKit UINavigationBar), so the system handles blur strength
          tracking with scroll, dynamic-type sizing, RTL, etc. */}
      <Stack.Screen options={{ title: title || "Session" }} />
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
