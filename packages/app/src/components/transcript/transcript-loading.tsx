import { ActivityIndicator, Text, View } from "react-native";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Loading placeholder for the session detail transcript.
 *
 * The transcript subscribe is a READ that keeps `await this.readyPromise`
 * at the facade — so when the daemon is offline it hangs (and auto-resumes
 * on reconnect) rather than rejecting. `useLiveQuery.isLoading` therefore
 * stays true the whole time offline, and a bare spinner would spin forever
 * with no signal. This component distinguishes the two cases on
 * `connectionStatus`:
 *   - online  → spinner (genuinely loading the snapshot)
 *   - not online → an offline message; the transcript loads automatically
 *     when the transport reattaches (facade replays the subscription).
 *
 * Lives in its own component (not inlined in `session/[cliSessionId].tsx`)
 * so the detail screen stays free of `useDaemonClient` — the same split as
 * `SessionBridgeToolbar`. See the screen's header note.
 */
export function TranscriptLoading() {
  const { connectionStatus } = useDaemonClient();

  if (connectionStatus === "online") {
    return (
      <View className="flex-1 items-center justify-center">
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <View className="flex-1 items-center justify-center px-6">
      <Text className="text-center text-base font-medium text-gray-500 dark:text-gray-400">
        Offline
      </Text>
      <Text className="mt-2 text-center text-xs text-gray-400 dark:text-gray-500">
        Reconnect to load this conversation.
      </Text>
    </View>
  );
}
