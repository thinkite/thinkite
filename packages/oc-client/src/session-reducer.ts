/**
 * Session list rows and the bus events that patch them.
 *
 * `SessionRow` is a flat view of opencode's `SessionInfo` (title,
 * directory, model, last update) plus the busy/idle flag derived from
 * `session.execution.*` events and the `session.active()` snapshot. It is
 * the one shape both the desktop sidebar and the phone drawer render.
 */

import type { SessionInfo } from "@opencode/client";
import type { OcEvent } from "./events.ts";
import { formatModelRef } from "./model-ref.ts";

export type SessionActivity = "running" | "idle";

export type SessionRow = {
  /** opencode `ses_*` id — the route param and transcript key. */
  id: string;
  title: string;
  /** `location.directory` — cwd for the terminal / diff panels. */
  directory: string;
  /** `providerID/modelID`, null when the session reports none. */
  model: string | null;
  /** `time.updated`, bumped locally on turn boundaries and new input. */
  updatedAt: number;
  activity: SessionActivity;
};

export function sessionRowFromInfo(
  info: SessionInfo,
  activity: SessionActivity,
): SessionRow {
  return {
    id: info.id,
    title: info.title ?? "",
    directory: info.location.directory,
    model:
      info.model !== undefined
        ? formatModelRef(info.model.providerID, info.model.id)
        : null,
    updatedAt: info.time.updated,
    activity,
  };
}

/** Row for a session the bus announced before any list read saw it. */
export function sessionRowFromCreated(
  event: Extract<OcEvent, { type: "session.created" }>,
): SessionRow {
  const { data } = event;
  return {
    id: data.sessionID,
    title: data.title ?? "",
    directory: data.location.directory,
    model:
      data.model !== undefined
        ? formatModelRef(data.model.providerID, data.model.id)
        : null,
    updatedAt: event.created,
    activity: "idle",
  };
}

/**
 * Patch one row with a bus event addressed to it. Returns the same object
 * when nothing changes. Creation and deletion are the collection's job.
 */
export function applySessionEvent(row: SessionRow, event: OcEvent): SessionRow {
  switch (event.type) {
    case "session.renamed":
      return { ...row, title: event.data.title, updatedAt: event.created };
    case "session.moved":
      return { ...row, directory: event.data.location.directory };
    case "session.model.selected":
      return {
        ...row,
        model: formatModelRef(event.data.model.providerID, event.data.model.id),
      };
    case "session.inbox.enqueued":
      return { ...row, updatedAt: Math.max(row.updatedAt, event.created) };
    case "session.execution.started":
      return {
        ...row,
        activity: "running",
        updatedAt: Math.max(row.updatedAt, event.created),
      };
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return {
        ...row,
        activity: "idle",
        updatedAt: Math.max(row.updatedAt, event.created),
      };
    default:
      return row;
  }
}
