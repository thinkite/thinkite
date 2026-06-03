/**
 * Tiny date helpers for the session list — hand-rolled on native `Date` +
 * `toLocaleDateString`, no date/i18n library. The need is trivial (calendar-day
 * bucketing + two special labels); revisit localization in V0.5+ once there are
 * real users.
 */

/**
 * Local-calendar-day key for bucketing timestamps, e.g. "2026-5-3". Compares
 * by Y/M/D (not a 24h window) so a late-night and an early-morning session
 * fall into the days they belong to. Same anchoring as `formatDaySection`.
 */
export function dayKey(epochMs: number): string {
  const d = new Date(epochMs);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Section header for grouping a session list by calendar day (Claude Desktop
 * style): "Today" / "Yesterday" / "Jun 1" (same year) / "Jun 1, 2024" (older).
 */
export function formatDaySection(epochMs: number, now = Date.now()): string {
  const k = dayKey(epochMs);
  if (k === dayKey(now)) return "Today";
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (k === dayKey(yesterday.getTime())) return "Yesterday";
  const d = new Date(epochMs);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}
