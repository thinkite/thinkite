/**
 * Format `epochMs` as a compact relative-time string anchored at `now`.
 * Examples: "now", "12 min", "3 hr", "2 days", "Apr 9".
 *
 * Deliberately tiny — no `Intl.RelativeTimeFormat` dependency, no i18n.
 * V0.5+ revisits localization once we have actual users.
 */
export function formatRelativeTime(epochMs: number, now = Date.now()): string {
  const diffSec = Math.max(0, Math.round((now - epochMs) / 1000));
  if (diffSec < 30) return "now";
  if (diffSec < 90) return "1 min";
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay} day${diffDay === 1 ? "" : "s"}`;
  // > 1 week ago: drop relative, switch to compact date.
  const date = new Date(epochMs);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Compact a cwd for display: replace the user's home prefix with `~` and
 * show just the last segment when the path is long.
 *
 * - `/Users/yueqian/Desktop/projects/sidecode/sidecode` → `~/…/sidecode`
 * - `/Users/yueqian/Desktop` → `~/Desktop`
 */
export function formatCwd(cwd: string, homeDir = "/Users/yueqian"): string {
  // Strip user's home with ~. Best-effort; iOS doesn't know the Mac home, so
  // pass it explicitly when the daemon learns to expose it. V0 default to a
  // common shape; mismatches just show the full path which is still readable.
  const withTilde = cwd.startsWith(`${homeDir}/`)
    ? `~${cwd.slice(homeDir.length)}`
    : cwd;
  // If the path is already short, return as-is.
  if (withTilde.length <= 36) return withTilde;
  // Otherwise show `~/…/<lastSegment>`.
  const segments = withTilde.split("/");
  const last = segments.at(-1) ?? "";
  return `~/…/${last}`;
}

/**
 * Project label used as a section header. Just the last path segment so
 * `/Users/x/Desktop/legion-ai/legion-backend` → `legion-backend`. Falls
 * back to the full path if there's no separator.
 */
export function projectName(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, "");
  const last = trimmed.split("/").at(-1) ?? "";
  return last || cwd;
}
