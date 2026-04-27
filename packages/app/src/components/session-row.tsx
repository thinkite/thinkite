import { Pressable, Text, View } from "react-native";
import { formatCwd, formatRelativeTime } from "@/lib/format";
import type { SessionInfo } from "@/types/session";

export interface SessionRowProps {
  session: SessionInfo;
  onPress?: (session: SessionInfo) => void;
}

export function SessionRow({ session, onPress }: SessionRowProps) {
  const title = session.title || "Untitled session";
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
      <View className="mt-1 flex-row items-baseline gap-2">
        <Text
          numberOfLines={1}
          className="flex-1 text-xs text-gray-500 dark:text-gray-400"
        >
          {formatCwd(session.cwd)}
        </Text>
        <Text className="text-xs text-gray-500 dark:text-gray-400">
          {session.model}
          {session.completedTurns !== undefined
            ? ` · ${session.completedTurns} turn${session.completedTurns === 1 ? "" : "s"}`
            : ""}
        </Text>
      </View>
    </Pressable>
  );
}
