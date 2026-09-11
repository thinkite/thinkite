/**
 * Transcript-collection tests: a fake `OcClient` (history pages + a
 * controllable session stream) and a fake bus, asserting the collection
 * mirrors the reducer, resumes with `after=` from `lastSeq`, routes bus
 * events by `sessionID`, and reconciles the optimistic send by key.
 */

import type { Collection } from "@tanstack/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SharedBus } from "../bus.ts";
import type { OcClient, SessionDurableEvent, V2Event } from "../client.ts";
import {
  createTranscriptCollections,
  type OrderedOcRow,
} from "./transcript.ts";

const SES = "ses_a";
const OTHER = "ses_b";

function durable(
  type: string,
  data: unknown,
  seq: number,
): SessionDurableEvent {
  return { type, data, durable: { seq } } as unknown as SessionDurableEvent;
}

function busEvent(type: string, data: unknown): V2Event {
  return { type, data } as unknown as V2Event;
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
    subscriberCount: () => subscribers.size,
  };
}

/** Push-driven session stream: yields only what the test pushes, ends on
 *  `close()` (which triggers the collection's `after=` re-open). */
class FakeStream {
  readonly calls: number[] = [];
  private queue: SessionDurableEvent[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  open(signal: AbortSignal): AsyncGenerator<SessionDurableEvent> {
    return this.iterate(signal);
  }

  push(event: SessionDurableEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = null;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
    this.wake = null;
  }

  private async *iterate(
    signal: AbortSignal,
  ): AsyncGenerator<SessionDurableEvent> {
    while (!this.closed) {
      if (signal.aborted) return;
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

function fakeClient(history: SessionDurableEvent[], stream: FakeStream) {
  const promptCalls: Array<{ sessionId: string; text: string; id?: string }> =
    [];
  let promptResolve: (() => void) | null = null;
  let promptReject: ((err: unknown) => void) | null = null;
  const client = {
    async history() {
      return { events: history, hasMore: false };
    },
    openSessionStream(
      _sessionId: string,
      after: number,
      { signal }: { signal: AbortSignal },
    ): AsyncGenerator<SessionDurableEvent> {
      stream.calls.push(after);
      return stream.open(signal);
    },
    prompt(sessionId: string, text: string, opts?: { id?: string }) {
      promptCalls.push({
        sessionId,
        text,
        ...(opts?.id !== undefined ? { id: opts.id } : {}),
      });
      return new Promise<void>((resolve, reject) => {
        promptResolve = resolve;
        promptReject = reject;
      });
    },
  };
  return {
    client: client as unknown as OcClient,
    promptCalls,
    resolvePrompt: () => promptResolve?.(),
    rejectPrompt: (err: unknown) => promptReject?.(err),
  };
}

const made: Array<Collection<OrderedOcRow, string>> = [];

afterEach(async () => {
  for (const coll of made.splice(0)) await coll.cleanup();
});

describe("transcript collections", () => {
  it("mirrors history and patches rows in place by identity", async () => {
    const bus = fakeBus();
    const stream = new FakeStream();
    const { client } = fakeClient(
      [
        durable(
          "session.next.prompt.admitted",
          { sessionID: SES, messageID: "m1", prompt: { text: "hi" } },
          1,
        ),
        durable(
          "session.next.text.started",
          { sessionID: SES, assistantMessageID: "a1", textID: "t1" },
          2,
        ),
      ],
      stream,
    );
    const transcripts = createTranscriptCollections({
      client,
      bus: bus as unknown as SharedBus,
    });
    const coll = transcripts.get(SES);
    made.push(coll);
    await coll.preload();

    expect(coll.size).toBe(2);
    expect(coll.get("m1")).toMatchObject({
      kind: "user",
      text: "hi",
      _order: 0,
    });
    expect(coll.get("a1:t1")).toMatchObject({
      kind: "text",
      text: "",
      streaming: true,
      _order: 1,
    });

    // A live delta for this session patches the streaming row in place
    // (`_order` unchanged, same key).
    bus.emit(
      busEvent("session.next.text.delta", {
        sessionID: SES,
        assistantMessageID: "a1",
        textID: "t1",
        delta: " wor",
      }),
    );
    expect(coll.get("a1:t1")).toMatchObject({
      text: " wor",
      streaming: true,
      _order: 1,
    });

    // The durable `ended` is authoritative and lands on the same key.
    stream.push(
      durable(
        "session.next.text.ended",
        {
          sessionID: SES,
          assistantMessageID: "a1",
          textID: "t1",
          text: "hello world",
        },
        3,
      ),
    );
    await vi.waitFor(() => {
      expect(coll.get("a1:t1")).toMatchObject({
        text: "hello world",
        streaming: false,
        _order: 1,
      });
    });
    expect(coll.size).toBe(2);

    // A delta for another session must be ignored by this collection.
    bus.emit(
      busEvent("session.next.text.delta", {
        sessionID: OTHER,
        assistantMessageID: "a1",
        textID: "t1",
        delta: "!!!",
      }),
    );
    expect(coll.get("a1:t1")).toMatchObject({ text: "hello world" });
  });

  it("re-opens the stream with after=lastSeq", async () => {
    const bus = fakeBus();
    const stream = new FakeStream();
    const { client } = fakeClient(
      [
        durable(
          "session.next.prompt.admitted",
          { sessionID: SES, messageID: "m1", prompt: { text: "hi" } },
          1,
        ),
        durable(
          "session.next.text.started",
          { sessionID: SES, assistantMessageID: "a1", textID: "t1" },
          2,
        ),
      ],
      stream,
    );
    const transcripts = createTranscriptCollections({
      client,
      bus: bus as unknown as SharedBus,
    });
    const coll = transcripts.get(SES);
    made.push(coll);
    await coll.preload();

    await vi.waitFor(() => {
      expect(stream.calls).toEqual([2]);
    });

    // Advance the durable cursor, then end the stream — the follow loop
    // waits out the backoff and re-opens from the new `lastSeq`.
    stream.push(
      durable(
        "session.next.text.ended",
        {
          sessionID: SES,
          assistantMessageID: "a1",
          textID: "t1",
          text: "done",
        },
        10,
      ),
    );
    await vi.waitFor(() => {
      expect(coll.get("a1:t1")).toMatchObject({
        text: "done",
        streaming: false,
      });
    });
    stream.close();
    await vi.waitFor(
      () => {
        expect(stream.calls.length).toBeGreaterThanOrEqual(2);
      },
      { timeout: 4000 },
    );
    expect(stream.calls[1]).toBe(10);
  });

  it("keeps one optimistic user row, replaced by prompt.admitted", async () => {
    const bus = fakeBus();
    const stream = new FakeStream();
    const { client, promptCalls, resolvePrompt } = fakeClient([], stream);
    const transcripts = createTranscriptCollections({
      client,
      bus: bus as unknown as SharedBus,
    });
    const coll = transcripts.get(SES);
    made.push(coll);
    await coll.preload();

    const tx = transcripts.sendUserMessage({
      sessionId: SES,
      userMessageUuid: "m1",
      text: "hi",
    });
    // `onMutate` paints synchronously, before the server admits anything.
    expect(coll.get("m1")).toMatchObject({ kind: "user", text: "hi" });
    expect(promptCalls).toEqual([{ sessionId: SES, text: "hi", id: "m1" }]);

    // The durable admitted event (same id as the prompt `id`) lands on the
    // same key with the server's copy of the text.
    stream.push(
      durable(
        "session.next.prompt.admitted",
        { sessionID: SES, messageID: "m1", prompt: { text: "hi from server" } },
        1,
      ),
    );
    resolvePrompt();
    await tx.isPersisted.promise;
    await vi.waitFor(() => {
      expect(coll.get("m1")).toMatchObject({
        kind: "user",
        text: "hi from server",
      });
    });
    expect(coll.size).toBe(1);
  });
});
