/**
 * Bus events that patch a session's `SessionInfo`, the row `session.list`
 * and `session.get` return. Mirrors the `session.*` cases of `handleEvent`
 * in `packages/client/src/solid/data.ts` on anomalyco/opencode `v2.1.2`
 * (MIT). Creation (which needs a `session.get`) and deletion belong to the
 * collection.
 *
 * One deliberate difference: the service bumps `time.updated` without an
 * event, so new input and turn boundaries bump it here too, which keeps the
 * sidebar's most-recent-first order live.
 */

import type { SessionInfo } from "@opencode/client";
import type { OcEvent } from "./events.ts";

export type SessionStatus = "idle" | "running";

function touched(info: SessionInfo, at: number): SessionInfo {
  return at > info.time.updated
    ? { ...info, time: { ...info.time, updated: at } }
    : info;
}

/** Returns the same object when the event changes nothing. */
export function applySessionEvent(
  info: SessionInfo,
  event: OcEvent,
): SessionInfo {
  switch (event.type) {
    case "session.renamed":
      return { ...info, title: event.data.title };
    case "session.moved":
      return {
        ...info,
        location: event.data.location,
        projectID: event.data.projectID,
        subpath: event.data.subpath,
      };
    case "session.model.selected":
      return { ...info, model: event.data.model };
    case "session.agent.selected":
      return { ...info, agent: event.data.agent };
    case "session.usage.updated":
      return { ...info, cost: event.data.cost, tokens: event.data.tokens };
    case "session.permissions":
      return { ...info, permissions: event.data.permissions };
    case "session.archived":
      return { ...info, time: { ...info.time, archived: event.created } };
    case "session.unarchived": {
      const { archived: _, ...time } = info.time;
      return { ...info, time };
    }
    case "session.inbox.enqueued":
    case "session.execution.started":
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return touched(info, event.created);
    default:
      return info;
  }
}

/** Busy/idle transition carried by an event, if any. */
export function statusFromEvent(event: OcEvent): SessionStatus | undefined {
  switch (event.type) {
    case "session.execution.started":
      return "running";
    case "session.execution.succeeded":
    case "session.execution.failed":
    case "session.execution.interrupted":
      return "idle";
    default:
      return undefined;
  }
}
