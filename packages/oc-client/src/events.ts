/**
 * Event helpers over the opencode 2 global bus.
 *
 * `@opencode/client` shares one `/api/event` connection between
 * subscribers but does not reconnect it: when the server closes the
 * stream (restart, idle) every subscriber's iterator ends. This module
 * owns the reconnect loop the official Solid `connection.ts` has —
 * backoff, an idle timeout (the server writes a keepalive comment every
 * 15 s; 45 s of silence means the connection is dead), and abort.
 *
 * Every (re)connection starts with a `server.connected` event from the
 * server, so consumers key their resync on that instead of a separate
 * reconnect callback.
 */

import type { OcClient, OpenCodeEvent } from "./client.ts";

export type OcEvent = OpenCodeEvent;
export type OcEventType = OpenCodeEvent["type"];
export type OcEventOf<T extends OcEventType> = Extract<
  OpenCodeEvent,
  { type: T }
>;

/** Session id an event is addressed to, when it carries one. */
export function sessionIDOf(event: OcEvent): string | undefined {
  const data = (event as { data?: { sessionID?: unknown } }).data;
  return typeof data?.sessionID === "string" ? data.sessionID : undefined;
}

/** Durable sequence number, present on persisted session events only. */
export function durableSeq(event: OcEvent): number | undefined {
  const durable = (event as { durable?: { seq?: unknown } }).durable;
  return typeof durable?.seq === "number" ? durable.seq : undefined;
}

export interface SubscribeEventsOptions {
  signal: AbortSignal;
  /** Silence longer than this (ms) tears the stream down for a reconnect.
   *  Default 45 000 — three server keepalive intervals. */
  idleTimeoutMs?: number;
  onError?: (error: unknown) => void;
}

/**
 * Consume the global bus until `signal` aborts, reconnecting with
 * exponential backoff (1 s → 10 s) whenever the stream ends or falls
 * silent. The handler runs synchronously per event; a throwing handler
 * is reported through `onError` and does not stop the loop.
 */
export async function subscribeEvents(
  client: OcClient,
  handler: (event: OcEvent) => void,
  options: SubscribeEventsOptions,
): Promise<void> {
  const idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
  let backoff = 1000;
  while (!options.signal.aborted) {
    const connection = new AbortController();
    const stop = () => connection.abort();
    options.signal.addEventListener("abort", stop, { once: true });
    let idle: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      if (idle !== undefined) clearTimeout(idle);
      idle = setTimeout(() => connection.abort(), idleTimeoutMs);
    };
    try {
      touch();
      for await (const event of client.events({
        signal: connection.signal,
        onActivity: touch,
      })) {
        backoff = 1000;
        try {
          handler(event);
        } catch (err) {
          options.onError?.(err);
        }
      }
    } catch (err) {
      if (!options.signal.aborted) options.onError?.(err);
    } finally {
      if (idle !== undefined) clearTimeout(idle);
      options.signal.removeEventListener("abort", stop);
      connection.abort();
    }
    if (options.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, backoff);
      options.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
    backoff = Math.min(backoff * 2, 10_000);
  }
}
