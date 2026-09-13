/**
 * Collection tests over a fake `OcClient`: a push-driven event stream
 * (`server.connected` first, like the real bus), projection pages, and
 * the session list. Asserts hydration, live folding, turn-end settle by
 * re-reading the tail, older-page prepend, resync on reconnect, and
 * busy/idle from execution events + the active snapshot.
 */

import type { Collection } from "@tanstack/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OcClient, SessionInfo, SessionMessageInfo } from "../client.ts";
import type { OcEvent } from "../events.ts";
import { createSessionsCollection, type SessionRow } from "./sessions.ts";
import { createTranscriptCollections } from "./transcript.ts";

const SES = "ses_a";

class FakeBus {
  private queue: OcEvent[] = [];
  private wake: (() => void) | null = null;
  private closeWake: (() => void) | null = null;
  connections = 0;

  push(event: OcEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = null;
  }

  /** End the current stream (server restart); the next subscribe reconnects. */
  close(): void {
    this.closeWake?.();
    this.closeWake = null;
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<OcEvent> {
    this.connections += 1;
    yield {
      type: "server.connected",
      id: `evt_c${this.connections}`,
      created: Date.now(),
      data: {},
    } as unknown as OcEvent;
    let closed = false;
    while (!signal.aborted && !closed) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          this.closeWake = () => {
            closed = true;
            resolve();
          };
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        continue;
      }
      yield this.queue.shift() as OcEvent;
    }
  }
}

function ev(
  type: string,
  data: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): OcEvent {
  return {
    type,
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    created: Date.now(),
    data,
    durable: { seq: 1 },
    ...extra,
  } as unknown as OcEvent;
}

function user(id: string, text: string, created: number): SessionMessageInfo {
  return { id, type: "user", text, time: { created } };
}

function info(id: string, title: string, updated: number): SessionInfo {
  return {
    id,
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated },
    title,
    location: { directory: `/tmp/${id}` },
  } as SessionInfo;
}

function fakeClient(opts: {
  bus: FakeBus;
  pages?: Array<{ messages: SessionMessageInfo[]; nextCursor?: string }>;
  sessions?: Array<{ sessions: SessionInfo[]; nextCursor?: string }>;
  active?: string[];
}) {
  const messageCalls: Array<{ cursor?: string }> = [];
  const listCalls: number[] = [];
  const prompts: Array<{ id?: string; text: string }> = [];
  let activeIDs = opts.active ?? [];
  const client = {
    events: ({ signal }: { signal: AbortSignal }) => opts.bus.iterate(signal),
    async listMessages(
      _sessionID: string,
      o: { limit?: number; cursor?: string } = {},
    ) {
      messageCalls.push(o);
      const page = opts.pages?.shift();
      return page ?? { messages: [] };
    },
    async listSessions() {
      listCalls.push(Date.now());
      return opts.sessions?.shift() ?? { sessions: [] };
    },
    async activeSessionIDs() {
      return new Set(activeIDs);
    },
    async prompt(_sessionID: string, text: string, o: { id?: string } = {}) {
      prompts.push({ id: o.id, text });
      return {
        id: o.id ?? "msg_x",
        sessionID: SES,
        timeCreated: Date.now(),
        type: "user",
        payload: { text },
        delivery: "steer",
      };
    },
  };
  return {
    client: client as unknown as OcClient,
    messageCalls,
    listCalls,
    prompts,
    setActive: (ids: string[]) => {
      activeIDs = ids;
    },
  };
}

const made: Array<{ cleanup(): Promise<void> }> = [];
afterEach(async () => {
  for (const coll of made.splice(0)) await coll.cleanup();
});

async function settled(ms = 30) {
  await new Promise((r) => setTimeout(r, ms));
}

const rowsOf = (coll: Collection<SessionMessageInfo, string>) =>
  [...coll.values()]
    .sort((a, b) => a.time.created - b.time.created)
    .map((r) => r.id);

describe("transcript collections", () => {
  it("hydrates from the newest projection page and prepends older pages on demand", async () => {
    const bus = new FakeBus();
    const older = [user("msg_1", "one", 1), user("msg_2", "two", 2)];
    const newest = [user("msg_3", "three", 3), user("msg_4", "four", 4)];
    const { client, messageCalls } = fakeClient({
      bus,
      pages: [
        { messages: newest.slice().reverse(), nextCursor: "c1" },
        { messages: older.slice().reverse() },
      ],
    });
    const transcripts = createTranscriptCollections({ client, pageSize: 2 });
    const coll = transcripts.get(SES);
    made.push(coll, transcripts.paging);
    await coll.preload();
    expect(rowsOf(coll)).toEqual(["msg_3", "msg_4"]);
    expect(transcripts.paging.get(SES)).toMatchObject({
      hasOlder: true,
      loading: false,
      hydrated: true,
    });
    await transcripts.loadOlder(SES);
    expect(rowsOf(coll)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"]);
    expect(transcripts.paging.get(SES)).toMatchObject({ hasOlder: false });
    expect(messageCalls).toEqual([{ limit: 2 }, { limit: 2, cursor: "c1" }]);
    // No cursor left: loadOlder is a no-op.
    await transcripts.loadOlder(SES);
    expect(messageCalls).toHaveLength(2);
  });

  it("folds live streaming events, then settles the turn from the projection tail", async () => {
    const bus = new FakeBus();
    const { client, messageCalls } = fakeClient({
      bus,
      pages: [
        { messages: [] },
        // Tail read after execution.succeeded: the server's version wins.
        {
          messages: [
            {
              id: "msg_a1",
              type: "assistant",
              agent: "build",
              model: { id: "m", providerID: "p" },
              content: [{ type: "text", text: "pong (server)" }],
              time: { created: 20, completed: 30 },
              finish: "stop",
            },
            user("msg_u1", "ping", 10),
          ],
        },
      ],
    });
    const transcripts = createTranscriptCollections({ client });
    const coll = transcripts.get(SES);
    made.push(coll, transcripts.paging);
    await coll.preload();
    expect(coll.size).toBe(0);

    bus.push(
      ev(
        "session.inbox.enqueued",
        {
          sessionID: SES,
          inboxID: "msg_u1",
          item: { type: "user", payload: { text: "ping" }, delivery: "steer" },
        },
        { created: 10 },
      ),
    );
    bus.push(
      ev(
        "session.step.started",
        {
          sessionID: SES,
          assistantMessageID: "msg_a1",
          agent: "build",
          model: { id: "m", providerID: "p" },
        },
        { created: 20 },
      ),
    );
    bus.push(
      ev("session.text.started", {
        sessionID: SES,
        assistantMessageID: "msg_a1",
        ordinal: 0,
      }),
    );
    bus.push(
      ev(
        "session.text.delta",
        {
          sessionID: SES,
          assistantMessageID: "msg_a1",
          ordinal: 0,
          delta: "po",
        },
        { durable: undefined },
      ),
    );
    bus.push(
      ev(
        "session.text.delta",
        {
          sessionID: SES,
          assistantMessageID: "msg_a1",
          ordinal: 0,
          delta: "ng",
        },
        { durable: undefined },
      ),
    );
    // Another session's event must not leak in.
    bus.push(
      ev(
        "session.text.delta",
        {
          sessionID: "ses_other",
          assistantMessageID: "msg_a1",
          ordinal: 0,
          delta: "XX",
        },
        { durable: undefined },
      ),
    );
    await settled();
    expect(rowsOf(coll)).toEqual(["msg_u1", "msg_a1"]);
    const streaming = coll.get("msg_a1");
    expect(
      streaming?.type === "assistant" && streaming.content[0]?.type === "text"
        ? streaming.content[0].text
        : null,
    ).toBe("pong");

    bus.push(ev("session.execution.succeeded", { sessionID: SES }));
    await settled();
    expect(messageCalls).toHaveLength(2);
    const after = coll.get("msg_a1");
    expect(
      after?.type === "assistant" && after.content[0]?.type === "text"
        ? after.content[0].text
        : null,
    ).toBe("pong (server)");
    expect(after?.type === "assistant" ? after.finish : null).toBe("stop");
  });

  it("re-reads the tail on reconnect and coalesces settle reads for non-streaming events", async () => {
    const bus = new FakeBus();
    const { client, messageCalls } = fakeClient({
      bus,
      pages: [{ messages: [] }, { messages: [] }, { messages: [] }],
    });
    const transcripts = createTranscriptCollections({ client, settleMs: 10 });
    const coll = transcripts.get(SES);
    made.push(coll, transcripts.paging);
    await coll.preload();
    expect(messageCalls).toHaveLength(1);
    // Three durable events the reducer ignores → one coalesced read.
    bus.push(ev("session.compaction.started", { sessionID: SES }));
    bus.push(ev("session.compaction.ended", { sessionID: SES }));
    bus.push(ev("session.revert.staged", { sessionID: SES }));
    await settled(40);
    expect(messageCalls).toHaveLength(2);
    // Server restart: the stream ends, the loop reconnects (backoff 1 s).
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    bus.close();
    await vi.advanceTimersByTimeAsync(1100);
    vi.useRealTimers();
    await settled(40);
    expect(bus.connections).toBe(2);
    expect(messageCalls).toHaveLength(3);
  });

  it("sends optimistically under the minted id and keeps one row once the bus echoes it", async () => {
    const bus = new FakeBus();
    const { client, prompts } = fakeClient({ bus, pages: [{ messages: [] }] });
    const transcripts = createTranscriptCollections({ client });
    const coll = transcripts.get(SES);
    made.push(coll, transcripts.paging);
    await coll.preload();
    const tx = transcripts.sendUserMessage({
      sessionId: SES,
      userMessageUuid: "msg_mint",
      text: "hello",
    });
    expect(coll.get("msg_mint")?.type).toBe("user");
    await tx.isPersisted.promise;
    expect(prompts).toEqual([{ id: "msg_mint", text: "hello" }]);
    bus.push(
      ev("session.inbox.enqueued", {
        sessionID: SES,
        inboxID: "msg_mint",
        item: { type: "user", payload: { text: "hello" }, delivery: "steer" },
      }),
    );
    await settled();
    expect(rowsOf(coll)).toEqual(["msg_mint"]);
  });
});

describe("sessions collection", () => {
  it("lists, seeds activity from the active snapshot, and patches rows from the bus", async () => {
    const bus = new FakeBus();
    const { client, listCalls } = fakeClient({
      bus,
      sessions: [
        { sessions: [info("ses_a", "Alpha", 300), info("ses_b", "Beta", 200)] },
      ],
      active: ["ses_b"],
    });
    const coll = createSessionsCollection({ client });
    made.push(coll);
    await coll.preload();
    expect(listCalls).toHaveLength(1);
    expect(coll.get("ses_a")).toMatchObject<Partial<SessionRow>>({
      title: "Alpha",
      directory: "/tmp/ses_a",
      activity: "idle",
      updatedAt: 300,
    });
    expect(coll.get("ses_b")?.activity).toBe("running");

    bus.push(ev("session.execution.started", { sessionID: "ses_a" }));
    bus.push(ev("session.renamed", { sessionID: "ses_b", title: "Beta 2" }));
    bus.push(
      ev("session.created", {
        sessionID: "ses_c",
        projectID: "p",
        location: { directory: "/tmp/c" },
        slug: "c",
        title: "Gamma",
        version: "1",
      }),
    );
    bus.push(ev("session.execution.succeeded", { sessionID: "ses_b" }));
    bus.push(ev("session.deleted", { sessionID: "ses_a" }));
    await settled();
    expect(coll.get("ses_a")).toBeUndefined();
    expect(coll.get("ses_b")).toMatchObject({
      title: "Beta 2",
      activity: "idle",
    });
    expect(coll.get("ses_c")).toMatchObject({
      title: "Gamma",
      directory: "/tmp/c",
      activity: "idle",
    });
  });

  it("resyncs the list on reconnect", async () => {
    const bus = new FakeBus();
    const { client, listCalls } = fakeClient({
      bus,
      sessions: [
        { sessions: [info("ses_a", "Alpha", 300)] },
        { sessions: [info("ses_z", "Zed", 400)] },
      ],
    });
    const coll = createSessionsCollection({ client });
    made.push(coll);
    await coll.preload();
    expect(listCalls).toHaveLength(1);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    bus.close();
    await vi.advanceTimersByTimeAsync(1100);
    vi.useRealTimers();
    await settled(40);
    expect(listCalls).toHaveLength(2);
    expect(coll.get("ses_a")).toBeUndefined();
    expect(coll.get("ses_z")?.title).toBe("Zed");
  });
});
