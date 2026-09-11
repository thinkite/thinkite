import { dayKey, formatDaySection } from "./format";

export interface DaySection<T> {
  title: string;
  data: T[];
}

/**
 * Bucket the recency-sorted sessions into calendar-day sections (Today /
 * Yesterday / "Jun 1" / …). `sessions` must already be sorted `updatedAt`
 * desc, so a single linear pass keeps both section order (most-recent day
 * first) and within-section recency. `now` is snapshotted once so every
 * row buckets against the same "today".
 *
 * Generic over `{ updatedAt }` so it stays a pure helper (testable
 * without the RN/session modules).
 */
export function groupSessionsByDay<T extends { updatedAt: number }>(
  sessions: readonly T[],
  now = Date.now(),
): DaySection<T>[] {
  const out: DaySection<T>[] = [];
  let currentKey: string | null = null;
  for (const session of sessions) {
    const key = dayKey(session.updatedAt);
    if (key !== currentKey) {
      out.push({
        title: formatDaySection(session.updatedAt, now),
        data: [],
      });
      currentKey = key;
    }
    out[out.length - 1].data.push(session);
  }
  return out;
}
