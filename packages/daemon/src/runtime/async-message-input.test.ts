import { describe, expect, it } from "vitest";
import { createAsyncMessageInput } from "./async-message-input.js";

describe("createAsyncMessageInput", () => {
  it("queued before consume — iterator pulls in FIFO order", async () => {
    const ch = createAsyncMessageInput<number>();
    ch.push(1);
    ch.push(2);
    ch.push(3);
    ch.end();
    const seen: number[] = [];
    for await (const v of ch.iterable) seen.push(v);
    expect(seen).toEqual([1, 2, 3]);
  });

  it("consumer waits for first push", async () => {
    const ch = createAsyncMessageInput<string>();
    const it = ch.iterable[Symbol.asyncIterator]();
    const pending = it.next();
    // No microtask-delivery yet — consumer is parked.
    let resolvedValue: string | undefined;
    void pending.then((r) => {
      if (!r.done) resolvedValue = r.value;
    });
    ch.push("hi");
    const result = await pending;
    expect(result).toEqual({ value: "hi", done: false });
    expect(resolvedValue).toBe("hi");
  });

  it("end() resolves all parked consumers with done:true", async () => {
    const ch = createAsyncMessageInput<number>();
    const it = ch.iterable[Symbol.asyncIterator]();
    const a = it.next();
    const b = it.next();
    ch.end();
    expect(await a).toEqual({ value: undefined, done: true });
    expect(await b).toEqual({ value: undefined, done: true });
  });

  it("push after end() is a no-op", async () => {
    const ch = createAsyncMessageInput<number>();
    ch.end();
    ch.push(99);
    const it = ch.iterable[Symbol.asyncIterator]();
    expect(await it.next()).toEqual({ value: undefined, done: true });
  });

  it("queued items drain even after end() before iteration starts", async () => {
    const ch = createAsyncMessageInput<number>();
    ch.push(1);
    ch.push(2);
    ch.end();
    const seen: number[] = [];
    for await (const v of ch.iterable) seen.push(v);
    expect(seen).toEqual([1, 2]);
  });

  it("end() is idempotent", () => {
    const ch = createAsyncMessageInput<number>();
    ch.end();
    expect(() => ch.end()).not.toThrow();
  });
});
