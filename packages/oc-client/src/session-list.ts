/**
 * Pure session-list reducer over the v2 session surface.
 *
 * Input: `/api/session` pages (`SessionV2Info`) plus the `session.created`
 * / `session.updated` / `session.deleted` bus events (whose `info` is the
 * sibling `Session` shape — both normalized here). Output: items sorted by
 * `time.updated` desc, archived sessions dropped (hidden, matching the
 * official GUI's trim-on-archive).
 */

import type { ModelRef } from "@opencode-ai/sdk/v2/types";

export interface OcSessionItem {
  id: string;
  title: string;
  /** `location.directory` (v2 list) or `directory` (bus info). */
  directory: string;
  model?: ModelRef;
  agent?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  cost?: number;
}

export interface OcSessionListState {
  items: OcSessionItem[];
  nextCursor?: string;
}

export function createInitialSessionListState(): OcSessionListState {
  return { items: [] };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null
    ? (v as Record<string, unknown>)
    : {};
}

/** Normalize one session info object from either surface. Null when the
 *  object is not a session (or is archived — hidden by design). */
export function normalizeSessionInfo(input: unknown): OcSessionItem | null {
  const info = record(input);
  const id = str(info.id);
  if (id === undefined) return null;
  const time = record(info.time);
  const archivedAt = num(time.archived);
  if (archivedAt !== undefined) return null;
  const directory =
    str(info.directory) ?? str(record(info.location).directory) ?? "";
  const updatedAt = num(time.updated) ?? 0;
  const createdAt = num(time.created) ?? updatedAt;
  const item: OcSessionItem = {
    id,
    title: str(info.title) ?? "",
    directory,
    createdAt,
    updatedAt,
  };
  const model = record(info.model);
  if (str(model.id) !== undefined && str(model.providerID) !== undefined) {
    item.model = {
      id: model.id as string,
      providerID: model.providerID as string,
      ...(str(model.variant) !== undefined
        ? { variant: model.variant as string }
        : {}),
    };
  }
  if (str(info.agent) !== undefined) item.agent = info.agent as string;
  if (num(info.cost) !== undefined) item.cost = info.cost as number;
  return item;
}

function byUpdatedDesc(a: OcSessionItem, b: OcSessionItem): number {
  return b.updatedAt - a.updatedAt;
}

/**
 * Merge one `/api/session` page. Pages arrive newest-first and may overlap
 * the bus-fed state; merge is by id (page wins on conflict), then re-sort.
 * `replace` resets (first page after reconnect); otherwise append-merge.
 */
export function applySessionListPage(
  state: OcSessionListState,
  page: { sessions: readonly unknown[]; nextCursor?: string },
  opts: { replace?: boolean } = {},
): OcSessionListState {
  const merged = new Map<string, OcSessionItem>();
  if (opts.replace !== true) {
    for (const item of state.items) merged.set(item.id, item);
  }
  for (const raw of page.sessions) {
    const item = normalizeSessionInfo(raw);
    if (item === null) {
      // Archived in a page listing: drop any bus-known row.
      const id = str(record(raw).id);
      if (id !== undefined) merged.delete(id);
      continue;
    }
    merged.set(item.id, item);
  }
  const items = [...merged.values()].sort(byUpdatedDesc);
  return page.nextCursor !== undefined
    ? { items, nextCursor: page.nextCursor }
    : { items };
}

/** Bus event with `{type, data: {sessionID, info}}` (the `/api/event`
 *  envelope). Unknown types return the input state untouched. */
export function applySessionListEvent(
  state: OcSessionListState,
  event: { type: string; data?: unknown },
): OcSessionListState {
  const data = record(event.data);
  switch (event.type) {
    case "session.created":
    case "session.updated": {
      const info = data.info;
      const item = normalizeSessionInfo(info);
      const sessionID = str(data.sessionID);
      if (item === null) {
        // Archive update (or unparseable info): hide the row when we can
        // key it.
        const id = str(record(info).id) ?? sessionID;
        if (id === undefined) return state;
        if (!state.items.some((s) => s.id === id)) return state;
        return { ...state, items: state.items.filter((s) => s.id !== id) };
      }
      const items = state.items.filter((s) => s.id !== item.id);
      items.push(item);
      items.sort(byUpdatedDesc);
      return { ...state, items };
    }
    case "session.deleted": {
      const info = record(data.info);
      const id = str(info.id) ?? str(data.sessionID);
      if (id === undefined) return state;
      if (!state.items.some((s) => s.id === id)) return state;
      return { ...state, items: state.items.filter((s) => s.id !== id) };
    }
    default:
      return state;
  }
}
