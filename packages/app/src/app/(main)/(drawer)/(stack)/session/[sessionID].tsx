import { isSessionNotFoundError } from "@thinkite/oc-client";
import {
  useConnectionStatus,
  useMessages,
  usePaging,
  useSession,
} from "@thinkite/oc-client/react";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ChatPanel } from "@/components/transcript/chat-panel";
import { TranscriptLoading } from "@/components/transcript/transcript-loading";
import { useDrawerUI } from "@/lib/drawer-ui";
import { getOcClient, ocStore } from "@/lib/oc";
import { flattenToBlocks } from "@/lib/transcript-blocks";

/**
 * Detail route. Renders the opencode transcript flattened into per-part
 * rows (text + tool).
 *
 * Route: /session/<sessionID>
 *  - sessionID: path slug — the opencode `ses_*` id
 *  - header title comes from the session in the store, NOT a route param —
 *    so it stays correct as opencode's title lands; falls back to
 *    "Session" until the list has it (e.g. cold deeplink)
 *
 * This screen opens the transcript in the store (newest page, then live
 * events) and owns the loading branch. The ready branch hands off to
 * <ChatPanel/>, which owns everything chat-surface — the virtualized list,
 * the sticky composer, the composer-inset pipeline, and in-session sends.
 * (The FIRST send for a new session fires from the new-session screen.)
 *
 * Why ChatPanel is a separate component rather than inlined here:
 * mounting ChatPanel only in the ready branch makes the chat surface's
 * lifecycle == session-ready lifecycle. The composer inset measurement and
 * the LegendList's `initialScrollAtEnd` commit start from a clean state on
 * each session switch. See chat-panel.tsx for the longer story.
 */
export default function SessionDetailScreen() {
  const { sessionID, cwd } = useLocalSearchParams<{
    sessionID: string;
    cwd?: string;
  }>();

  useEffect(() => {
    void ocStore.open(sessionID);
  }, [sessionID]);
  const session = useSession(ocStore, sessionID);
  const messages = useMessages(ocStore, sessionID);
  const { hydrated } = usePaging(ocStore, sessionID);

  // The session can leave the store while the screen is open: deleted here
  // (the sidebar's Delete doesn't navigate) or elsewhere (opencode desktop,
  // Thinkite desktop, the CLI), or not in a resync's list, which holds only
  // the latest sessions. Ask the service which, as the desktop does: a
  // session still there comes back into the store; only "not found" turns
  // the screen into SessionNotFound. A service that can't be reached leaves
  // the screen as it is, to ask again once the connection is back.
  const gone = session === undefined;
  const connected = useConnectionStatus(ocStore) === "ready";
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!gone || !connected) return;
    let live = true;
    getOcClient()
      .getSession(sessionID)
      .then(
        () => {
          if (live) void ocStore.loadSession(sessionID);
        },
        (err: unknown) => {
          if (!live) return;
          if (isSessionNotFoundError(err)) setMissing(true);
          else console.warn("[session] reload failed:", err);
        },
      );
    return () => {
      live = false;
    };
  }, [gone, connected, sessionID]);

  // Drawer-settle gate. Mounting ChatPanel is heavy on the MAIN thread (native
  // view inflation + enriched's dispatch_sync measure), which the drawer-close
  // animation (Reanimated, UI thread) directly competes with — JS fps can look
  // fine while the close visibly stutters. A sidebar tap records THIS session's
  // id as the drawer's `transitioningSessionId` (in closeDrawer) in the same
  // batch as the route swap, so the session being navigated TO mounts gated and
  // shows the cheap TranscriptLoading; ChatPanel mounts once the close lands
  // (onTransitionEnd clears the id). Every other entry path — deep link,
  // new-session replace, the drawer merely opening over an already-settled
  // session — has `transitioningSessionId !== sessionID`. Carrying the id
  // (vs a bare `closing` boolean) means only the target session gates, and it
  // lets the sidebar no-op a tap on the already-open session (handleOpenSession).
  // The gate is a derived boolean: no state, no effect, no per-session keying.
  const { transitioningSessionId, openDrawer } = useDrawerUI();
  const drawerSettled = transitioningSessionId !== sessionID;

  const blocks = useMemo(() => flattenToBlocks(messages), [messages]);
  // A just-created session already shows its optimistic first prompt, so
  // rows on screen count as ready before the first page is read.
  const ready = hydrated || blocks.length > 0;

  return (
    <>
      {/* Title via Stack.Screen options. Header chrome (transparent +
          Liquid Glass blur) and the hamburger button via the new SDK 56
          Stack.Header / Stack.Toolbar APIs — these render natively
          (UIKit UINavigationBar), so the system handles blur strength
          tracking with scroll, dynamic-type sizing, RTL, etc. */}
      <Stack.Screen options={{ title: session?.title || "New session" }} />
      <Stack.Header transparent />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button icon="line.3.horizontal" onPress={openDrawer} />
      </Stack.Toolbar>
      {/* ToolCallSheetProvider lives in (stack)/_layout.tsx so its resident
          webview + worker pool are shared across session switches. */}
      <View className="flex-1 bg-white dark:bg-black">
        {gone && missing ? (
          <SessionNotFound sessionID={sessionID} />
        ) : !ready || !drawerSettled ? (
          <TranscriptLoading />
        ) : (
          <ChatPanel
            sessionID={sessionID}
            cwd={cwd ?? session?.location.directory}
            blocks={blocks}
          />
        )}
      </View>
    </>
  );
}

/** An open session that was deleted, after opencode's page for it: what
 *  happened, which session, and the way to a new one. */
function SessionNotFound({ sessionID }: { sessionID: string }) {
  return (
    <View className="flex-1 items-center justify-center gap-4 px-8">
      <View className="items-center gap-2">
        <Text className="text-base font-semibold text-black dark:text-white">
          This session cannot be found
        </Text>
        <Text className="text-center text-sm text-zinc-500 dark:text-zinc-400">
          It was deleted, perhaps from another app.
        </Text>
      </View>
      <Text
        selectable
        className="rounded bg-black/5 px-1.5 py-0.5 text-xs text-zinc-700 dark:bg-white/10 dark:text-zinc-300"
        // The transcript's code font (lib/markdown/chat-markdown.tsx).
        style={{ fontFamily: "JetBrains Mono" }}
      >
        {sessionID}
      </Text>
      <Pressable
        // The new-session page, swapped in as the sidebar's New Chat does.
        onPress={() => router.replace("/")}
        accessibilityRole="button"
        className="px-5 h-11 items-center justify-center rounded-full bg-black/5 dark:bg-white/10"
      >
        <Text className="text-[15px] font-semibold text-black dark:text-white">
          Back to home
        </Text>
      </Pressable>
    </View>
  );
}
