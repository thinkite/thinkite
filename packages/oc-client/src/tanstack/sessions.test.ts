/**
 * Sessions-collection tests: a fake `OcClient` (list pages + active seed)
 * and a fake bus, asserting page mirroring, `session.created/updated/
 * deleted`, busy/idle from step events, and the status registry letting
 * the transcript's durable reading override a stale bus reading.
 */

import type { Collection } from "@tanstack/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedBus } from "../bus.ts";
import type { OcClient, SessionDurableEvent, V2Event } from "../client.ts";
import { createSessionsCollection, type SessionRow } from "./sessions.ts";
import {
  createTranscriptCollections,
  type OrderedOcRow,
} from "./transcript.ts";

const SES_A = {
  id: "ses_a",
  projectID: "p",
  agent: "build",
  model: { id: "m1", providerID: "prov" },
  cost: 0,
  time: { created: 100, updated: 300 },
  title: "Alpha",
  location: { directory: "/tmp/a" },
};

const SES_B = {
  ...SES_A,
  id: "ses_b",
  title: "Beta",
  time: { created: 100, updated: 200 },
  location: { directory: "/tmp/b" },
};

function busEvent(type: string, data: unknown): V2Event {
  return { type, data } as unknown as V2Event;
}

function durable(
  type: string,
  data: unknown,
  seq: number,
): SessionDurableEvent {
  return { type, data, durable: { seq } } as unknown as SessionDurableEvent;
}

function fakeBus() {
  const subscribers = new Set<(event: V2Event) => void>();
  return {
    subscribe(fn: (event: V2Event) => void): () => void {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
    emit(event: V2Event): void {
      for (const fn of [...subscribers]) fn(event);
    },
  };
}

function fakeSessionsClient(
  pages: Array<{ sessions: unknown[]; nextCursor?: string }>,
  active: string[] = [],
) {
  const listCalls: Array<{ cursor?: string }> = [];
  const client = {
    async listSessions(opts: { cursor?: string } = {}) {
      listCalls.push(opts);
      return pages.shift() ?? { sessions: [] };
    },
    async activeSessionIDs() {
      return new Set(active);
    },
  };
  return { client: client as unknown as OcClient, listCalls };
}

class FakeStream {
  private queue: SessionDurableEvent[] = [];
  private wake: (() => void) | null = null;

  open(signal: AbortSignal): AsyncGenerator<SessionDurableEvent> {
    return this.iterate(signal);
  }

  push(event: SessionDurableEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = null;
  }

  private async *iterate(
    signal: AbortSignal,
  ): AsyncGenerator<SessionDurableEvent> {
    while (!signal.aborted) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        continue;
      }
      yield this.queue.shift() as SessionDurableEvent;
    }
  }
}

const madeSessions: Array<Collection<SessionRow, string>> = [];
const madeTranscripts: Array<Collection<OrderedOcRow, string>> = [];

afterEach(async () => {
  for (const coll of madeTranscripts.splice(0)) await coll.cleanup();
  for (const coll of madeSessions.splice(0)) await coll.cleanup();
});

describe("sessions collection", () => {
  it("mirrors list pages and created/updated/deleted events", async () => {
    const bus = fakeBus();
    const { client, listCalls } = fakeSessionsClient([
      { sessions: [SES_B, SES_A] },
    ]);
    const coll = createSessionsCollection({
      client,
      bus: bus as unknown as SharedBus,
    });
    madeSessions.push(coll);
    await coll.preload();

    expect(listCalls).toHaveLength(1);
    expect(coll.size).toBe(2);
    expect(coll.get("ses_a")).toMatchObject({
      title: "Alpha",
      directory: "/tmp/a",
      model: "prov/m1",
      activity: "idle",
    });

    bus.emit(
      busEvent("session.created", {
        sessionID: "ses_c",
        info: {
          ...SES_A,
          id: "ses_c",
          title: "Gamma",
          directory: "/tmp/c",
          time: { created: 50, updated: 400 },
        },
      }),
    );
    expect(coll.get("ses_c")).toMatchObject({
      title: "Gamma",
      directory: "/tmp/c",
    });

    bus.emit(
      busEvent("session.updated", {
        sessionID: "ses_c",
        info: {
          ...SES_A,
          id: "ses_c",
          title: "Gamma 2",
          directory: "/tmp/c",
          time: { created: 50, updated: 500 },
        },
      }),
    );
    expect(coll.get("ses_c")?.title).toBe("Gamma 2");

    bus.emit(
      busEvent("session.deleted", {
        sessionID: "ses_c",
        info: { id: "ses_c" },
      }),
    );
    expect(coll.get("ses_c")).toBeUndefined();
    expect(coll.size).toBe(2);
  });

  it("derives busy/idle from step events and the active seed", async () => {
    const bus = fakeBus();
    const { client } = fakeSessionsClient([{ sessions: [SES_A] }], ["ses_a"]);
    const coll = createSessionsCollection({
      client,
      bus: bus as unknown as SharedBus,
    });
    madeSessions.push(coll);
    await coll.preload();

    // Seeded busy: the turn was already running at app start.
    expect(coll.get("ses_a")?.activity).toBe("running");

    bus.emit(busEvent("session.next.step.ended", { sessionID: "ses_a" }));
    expect(coll.get("ses_a")?.activity).toBe("idle");

    bus.emit(busEvent("session.next.step.started", { sessionID: "ses_a" }));
    expect(coll.get("ses_a")?.activity).toBe("running");

    // `finish: "tool-calls"` continues into the next step — stay busy.
    bus.emit(
      busEvent("session.next.step.ended", {
        sessionID: "ses_a",
        finish: "tool-calls",
      }),
    );
    expect(coll.get("ses_a")?.activity).toBe("running");

    bus.emit(busEvent("session.next.step.ended", { sessionID: "ses_a" }));
    expect(coll.get("ses_a")?.activity).toBe("idle");

    bus.emit(busEvent("session.next.step.started", { sessionID: "ses_a" }));
    bus.emit(busEvent("session.next.step.failed", { sessionID: "ses_a" }));
    expect(coll.get("ses_a")?.activity).toBe("idle");

    // Unrelated events leave turn state alone.
    bus.emit(
      busEvent("session.next.text.delta", {
        sessionID: "ses_a",
        assistantMessageID: "a1",
        textID: "t1",
        delta: "x",
      }),
    );
    expect(coll.get("ses_a")?.activity).toBe("idle");
  });

  it("lets the durable transcript status override a stale bus reading", async () => {
    const bus = fakeBus();
    const { client: sessionsClient } = fakeSessionsClient([
      { sessions: [SES_A] },
    ]);
    const sessions = createSessionsCollection({
      client: sessionsClient,
      bus: bus as unknown as SharedBus,
    });
    madeSessions.push(sessions);
    await sessions.preload();

    // The bus reports the turn started, then drops the `step.ended` — the
    // sessions row would stay stuck on "running".
    bus.emit(busEvent("session.next.step.started", { sessionID: "ses_a" }));
    expect(sessions.get("ses_a")?.activity).toBe("running");

    // The durable transcript stream replays the step start, then delivers
    // the end the bus dropped and publishes idle into the registry.
    const stream = new FakeStream();
    const transcripts = createTranscriptCollections({
      client: {
        async history() {
          return {
            events: [
              durable("session.next.step.started", { sessionID: "ses_a" }, 1),
            ],
            hasMore: false,
          };
        },
        openSessionStream(
          _sessionId: string,
          _after: number,
          { signal }: { signal: AbortSignal },
        ) {
          return stream.open(signal);
        },
      } as unknown as OcClient,
      bus: bus as unknown as SharedBus,
    });
    const transcript = transcripts.get("ses_a");
    madeTranscripts.push(transcript);
    await transcript.preload();

    stream.push(
      durable(
        "session.next.step.ended",
        { sessionID: "ses_a", finish: "stop" },
        2,
      ),
    );
    await vi.waitFor(() => {
      expect(sessions.get("ses_a")?.activity).toBe("idle");
    });
  });
});
