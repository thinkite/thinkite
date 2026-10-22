/** Immutable helpers for the `Record<id, …>` shapes the store's atoms hold. */

export type Records<T> = Readonly<Record<string, T>>;

export function put<T>(record: Records<T>, key: string, value: T): Records<T> {
  return record[key] === value ? record : { ...record, [key]: value };
}

export function drop<T>(record: Records<T>, key: string): Records<T> {
  if (!(key in record)) return record;
  const { [key]: _, ...rest } = record;
  return rest;
}

/** Add or replace one item of a per-session list, by id. */
export function upsertIn<T extends { id: string }>(
  record: Records<readonly T[]>,
  sessionID: string,
  item: T,
): Records<readonly T[]> {
  const list = record[sessionID] ?? [];
  const at = list.findIndex((x) => x.id === item.id);
  return put(
    record,
    sessionID,
    at < 0 ? [...list, item] : list.map((x, i) => (i === at ? item : x)),
  );
}

/** Remove one item by id from whichever session's list holds it. */
export function removeIn<T extends { id: string }>(
  record: Records<readonly T[]>,
  id: string,
): Records<readonly T[]> {
  for (const [sessionID, list] of Object.entries(record)) {
    if (!list.some((x) => x.id === id)) continue;
    const rest = list.filter((x) => x.id !== id);
    return rest.length > 0
      ? put(record, sessionID, rest)
      : drop(record, sessionID);
  }
  return record;
}
