import { prettyModel } from "@sidecodeapp/protocol";
import { Pressable, Text, View } from "react-native";
import { formatRelativeTime } from "@/lib/format";
import type { SessionRow as SessionRowData } from "@/lib/sessions-collection";

export interface SessionRowProps {
  session: SessionRowData;
  onPress?: (session: SessionRowData) => void;
}

/**
 * One row in the flat session list. Per [[project_v0_session_list_design]]:
 *
 *   - title + lastActivityAt + activity dot + model chip
 *   - NO cwd line (the detail screen's git status bar owns project context)
 *   - NO project grouping (the parent is a flat FlatList)
 *
 * The model `displayName` is looked up via the bundled `prettyModel`
 * helper (full MODEL_METADATA table, including deprecated entries so a
 * historical session that was created on an older model still renders
 * a friendly label). Falls back to the raw model id if the lookup misses
 * (e.g. a brand-new model that sidecode hasn't been updated for).
 */
export function SessionRow({ session, onPress }: SessionRowProps) {
  const title = session.title || "Untitled session";
  const modelLabel = session.model ? prettyModel(session.model) : "";
  const isRunning = session.activity === "running";

  return (
    <Pressable
      onPress={onPress ? () => onPress(session) : undefined}
      className="px-4 py-3 active:bg-gray-100 dark:active:bg-gray-900"
    >
      <View className="flex-row items-baseline gap-2">
        <Text
          numberOfLines={1}
          className="flex-1 text-base font-medium text-black dark:text-white"
        >
          {title}
        </Text>
        <Text className="text-xs text-gray-500 dark:text-gray-400">
          {formatRelativeTime(session.lastActivityAt)}
        </Text>
      </View>
      <View className="mt-1 flex-row items-center gap-2">
        {/* Activity dot: blue when running, gray when idle. Square 6×6
            with rounded-full for the standard "pill indicator" look. */}
        <View
          className={
            isRunning
              ? "h-2 w-2 rounded-full bg-blue-500"
              : "h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-700"
          }
        />
        <Text
          numberOfLines={1}
          className="flex-1 text-xs text-gray-500 dark:text-gray-400"
        >
          {modelLabel}
        </Text>
      </View>
    </Pressable>
  );
}
