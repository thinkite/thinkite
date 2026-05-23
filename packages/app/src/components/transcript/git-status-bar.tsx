import { GlassView } from "expo-glass-effect";
import { Pressable, Text, useColorScheme, View } from "react-native";
import { useGitStatus } from "@/hooks/use-git-status";

/**
 * Workspace status bar — sits above the InputBar in the session view,
 * mirrors the bar Claude Desktop shows above its composer.
 *
 * Contents: project basename · branch · `+N -M` pill (only when there
 * are actually changes). The pill auto-hides on a clean tree so the
 * row is just an ambient "you are on branch X" indicator when nothing's
 * pending — Claude Desktop hides the whole bar in that case, but we
 * keep the branch label visible since it's useful context for "should
 * I switch branch before asking Claude to ..." even with no diff yet.
 *
 * No "Create PR" button — that action goes through Claude (user types
 * "create a PR" → Claude runs `gh pr create`). The `+N -M` pill is
 * `Pressable` for the V0.5+ "tap to view diff" flow; today onPress is
 * a no-op log.
 *
 * The whole bar auto-hides when: no `cwd` (fresh session before first
 * prompt fixes the cwd), client not connected, or the cwd isn't a git
 * repo.
 *
 * Visual language matches InputBar: GlassView shell with a
 * semi-transparent fallback for iOS<26 / Android (where GlassView
 * degrades to a plain View), inner padding via RN/Uniwind.
 */
export function GitStatusBar({ cwd }: { cwd: string | undefined }) {
  const colorScheme = useColorScheme() ?? "light";
  const status = useGitStatus(cwd);

  if (!status?.isRepo) return null;

  const hasChanges = status.insertions > 0 || status.deletions > 0;

  return (
    <View className="px-4 pb-2">
      <GlassView
        style={{
          borderRadius: 18,
          borderCurve: "continuous",
          backgroundColor:
            colorScheme === "dark"
              ? "rgba(28,28,30,0.55)"
              : "rgba(255,255,255,0.55)",
        }}
      >
        <View className="flex-row items-center gap-2.5 px-4 h-11">
          <Text className="text-sm text-zinc-500 dark:text-zinc-400">
            {status.project}
          </Text>
          <Text className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {status.branch ?? "—"}
          </Text>
          <View className="flex-1" />
          {hasChanges && (
            <Pressable
              onPress={() => {
                console.log("[git-status-bar] diff pill pressed");
              }}
              className="flex-row items-center gap-1 rounded-md border border-zinc-300 px-2 h-6 dark:border-zinc-700"
            >
              <Text className="text-sm font-medium text-green-600 dark:text-green-500">
                +{status.insertions}
              </Text>
              <Text className="text-sm font-medium text-red-600 dark:text-red-500">
                -{status.deletions}
              </Text>
            </Pressable>
          )}
        </View>
      </GlassView>
    </View>
  );
}
