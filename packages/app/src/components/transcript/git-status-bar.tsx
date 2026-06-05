import { GlassView } from "expo-glass-effect";
import { SymbolView } from "expo-symbols";
import { Pressable, Text, useColorScheme, View } from "react-native";
import { useGitStatus } from "@/hooks/use-git-status";

/**
 * Workspace status bar — composer chrome above the InputBar. Renders
 * on every page that has a composer (new-session screen + session
 * detail) so the layout stays stable across pages.
 *
 * State machine (all three states share the same outer GlassView shape):
 *   - cwd undefined → "Select a project" placeholder + chevron;
 *     onPress (when provided) opens the cwd picker
 *   - cwd set, not a git repo → project basename only
 *   - cwd set, git repo → project · branch · "+N -M" pill (pill only
 *     when there are changes — clean tree just shows ambient branch
 *     label, matching the "useful context for 'should I switch
 *     branch?'" call mirrored from Claude Desktop)
 *
 * Tap behavior (context-dependent — callers wire onPress):
 *   - new-session screen → open cwd picker (this is how user selects
 *     project for the next session)
 *   - session detail (V0) → undefined (Pressable is noop)
 *   - session detail (V0.5+) → open the git diff page
 *
 * No "Create PR" button — that action goes through Claude (user types
 * "create a PR" → Claude runs `gh pr create`).
 *
 * Visual language matches InputBar: GlassView shell with a
 * semi-transparent fallback for iOS<26 / Android (where GlassView
 * degrades to a plain View), inner padding via RN/Uniwind.
 */
export function GitStatusBar({
  cwd,
  onPress,
  onStatusChange,
  showChanges = true,
}: {
  cwd: string | undefined;
  /** Tap handler. Omitting yields a non-interactive bar (Pressable
   *  with no onPress is a noop). new-session screen wires this to
   *  the cwd picker; detail page wires it to the working-tree diff. */
  onPress?: () => void;
  /** Fired on each git-status push for `cwd` — forwarded straight to
   *  `useGitStatus`. The session-detail caller uses it to invalidate the
   *  working-tree-diff query (kept out of this generic bar so the new-session
   *  screen, which has no diff sheet, doesn't carry that coupling). */
  onStatusChange?: () => void;
  /** Show the "+N -M" change-count pill (when cwd is a git repo with
   *  pending changes). Default true to preserve detail-page behavior.
   *  New-session screen passes false: the bar is a cwd PICKER there
   *  and the diff count is noise — user is selecting a project, not
   *  reviewing one. Branch label still shows in both cases. */
  showChanges?: boolean;
}) {
  const colorScheme = useColorScheme() ?? "light";
  const status = useGitStatus(cwd, onStatusChange);

  const isPlaceholder = cwd === undefined;
  const isRepo = status?.isRepo === true;
  const hasChanges =
    isRepo && showChanges && (status.insertions > 0 || status.deletions > 0);

  return (
    <View className="px-4 pb-2">
      <GlassView
        isInteractive
        style={{
          borderRadius: 18,
          borderCurve: "continuous",
          backgroundColor:
            colorScheme === "dark"
              ? "rgba(28,28,30,0.55)"
              : "rgba(255,255,255,0.55)",
        }}
      >
        <Pressable
          onPress={onPress}
          className="flex-row items-center gap-2 px-4 h-10"
        >
          {isPlaceholder ? (
            <Text className="flex-1 text-sm text-zinc-500 dark:text-zinc-400">
              Select a project
            </Text>
          ) : (
            <>
              <Text className="text-sm text-zinc-500 dark:text-zinc-400">
                {status?.project ?? basename(cwd)}
              </Text>
              {isRepo && (
                <Text className="text-sm text-zinc-900 dark:text-zinc-100">
                  {status.branch ?? "—"}
                </Text>
              )}
              <View className="flex-1" />
              {hasChanges && (
                <View className="flex-row items-center gap-1">
                  <Text className="text-sm text-green-600 dark:text-green-500">
                    +{status.insertions}
                  </Text>
                  <Text className="text-sm text-red-600 dark:text-red-500">
                    -{status.deletions}
                  </Text>
                </View>
              )}
            </>
          )}
          {/* Chevron when there's a tap target. Signals the bar is
              interactive (placeholder always, detail page conditionally
              once V0.5+ wires the diff page). */}
          {onPress !== undefined && (
            <SymbolView
              name="chevron.right"
              size={12}
              weight="semibold"
              tintColor={colorScheme === "dark" ? "#71717a" : "#a1a1aa"}
            />
          )}
        </Pressable>
      </GlassView>
    </View>
  );
}

/** Cheap last-segment fallback for the placeholder/non-repo path so
 *  the bar still shows SOMETHING readable when git-status hasn't
 *  resolved yet. */
function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}
