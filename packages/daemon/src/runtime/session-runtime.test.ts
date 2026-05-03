import { describe, expect, it, vi } from "vitest";
import { SessionRuntime, type RuntimeQueryHandle } from "./session-runtime.js";

describe("SessionRuntime", () => {
  it("addEvent assigns cursors monotonically starting at 1", () => {
    const r = new SessionRuntime<string>("s1");
    expect(r.currentCursor).toBe(0);
    expect(r.oldestCursor).toBeNull();

    const e1 = r.addEvent("a");
    const e2 = r.addEvent("b");
    const e3 = r.addEvent("c");

    expect(e1.cursor).toBe(1);
    expect(e2.cursor).toBe(2);
    expect(e3.cursor).toBe(3);
    expect(r.currentCursor).toBe(3);
    expect(r.oldestCursor).toBe(1);
  });

  it("evicts oldest when bufferCap is exceeded", () => {
    const r = new SessionRuntime<string>("s1", { bufferCap: 3 });
    r.addEvent("a"); // cursor 1
    r.addEvent("b"); // cursor 2
    r.addEvent("c"); // cursor 3
    expect(r.oldestCursor).toBe(1);
    r.addEvent("d"); // cursor 4; "a" evicted
    expect(r.oldestCursor).toBe(2);
    r.addEvent("e"); // cursor 5; "b" evicted
    expect(r.oldestCursor).toBe(3);
    expect(r.currentCursor).toBe(5);
  });

  it("subscribe with default sinceCursor replays the entire buffer", () => {
    const r = new SessionRuntime<string>("s1");
    r.addEvent("a");
    r.addEvent("b");
    r.addEvent("c");
    const seen: string[] = [];
    r.subscribe((e) => seen.push(e.payload));
    expect(seen).toEqual(["a", "b", "c"]);
  });

  it("subscribe with sinceCursor=N skips events with cursor <= N", () => {
    const r = new SessionRuntime<string>("s1");
    r.addEvent("a"); // 1
    r.addEvent("b"); // 2
    r.addEvent("c"); // 3
    const seen: number[] = [];
    r.subscribe((e) => seen.push(e.cursor), 2);
    expect(seen).toEqual([3]);
  });

  it("subscribe with sinceCursor at currentCursor replays nothing", () => {
    const r = new SessionRuntime<string>("s1");
    r.addEvent("a");
    r.addEvent("b");
    const seen: string[] = [];
    r.subscribe((e) => seen.push(e.payload), r.currentCursor);
    expect(seen).toEqual([]);
  });

  it("subscribe registers cb for future events", () => {
    const r = new SessionRuntime<string>("s1");
    const seen: number[] = [];
    r.subscribe((e) => seen.push(e.cursor));
    r.addEvent("a"); // 1
    r.addEvent("b"); // 2
    expect(seen).toEqual([1, 2]);
  });

  it("returned unsubscribe stops fanout", () => {
    const r = new SessionRuntime<string>("s1");
    const seen: string[] = [];
    const unsub = r.subscribe((e) => seen.push(e.payload));
    r.addEvent("a");
    unsub();
    r.addEvent("b");
    expect(seen).toEqual(["a"]);
    expect(r.subscriberCount).toBe(0);
  });

  it("returned unsubscribe is idempotent", () => {
    const r = new SessionRuntime<string>("s1");
    const cb = vi.fn();
    const unsub = r.subscribe(cb);
    unsub();
    unsub(); // second call is a no-op
    expect(r.subscriberCount).toBe(0);

    // Re-subscribing the same cb after unsub should still work.
    r.subscribe(cb);
    r.addEvent("x");
    expect(cb).toHaveBeenCalledOnce();
  });

  it("explicit unsubscribe(cb) removes; returns false for absent cb", () => {
    const r = new SessionRuntime<string>("s1");
    const cb = vi.fn();
    r.subscribe(cb);
    expect(r.unsubscribe(cb)).toBe(true);
    expect(r.unsubscribe(cb)).toBe(false);
    r.addEvent("a");
    expect(cb).not.toHaveBeenCalled();
  });

  it("multiple subscribers all receive the same event", () => {
    const r = new SessionRuntime<string>("s1");
    const a: string[] = [];
    const b: string[] = [];
    r.subscribe((e) => a.push(e.payload));
    r.subscribe((e) => b.push(e.payload));
    r.addEvent("x");
    expect(a).toEqual(["x"]);
    expect(b).toEqual(["x"]);
  });

  it("isIdle reflects subscribers + query state", () => {
    const r = new SessionRuntime<string>("s1");
    expect(r.isIdle).toBe(true);

    const unsub = r.subscribe(() => {});
    expect(r.isIdle).toBe(false);
    unsub();
    expect(r.isIdle).toBe(true);

    const queryStub: RuntimeQueryHandle = {
      interrupt: async () => {},
      close: () => {},
    };
    r.query = queryStub;
    expect(r.isIdle).toBe(false);
    r.query = null;
    expect(r.isIdle).toBe(true);
  });

  it("reentrant addEvent during replay lands in the buffer but doesn't roundtrip", () => {
    // Contract: subscribe replays buffered events first, THEN attaches cb
    // to the live fanout. So if cb triggers addEvent during replay, the
    // new event reaches the buffer (and future subscribers) but not the
    // currently-replaying cb on this same call. This keeps replay order
    // monotonic — no weird interleaving of past + reentrantly-triggered
    // present events.
    const r = new SessionRuntime<string>("s1");
    r.addEvent("seed"); // cursor 1

    const seen: number[] = [];
    let triggered = false;
    r.subscribe((e) => {
      seen.push(e.cursor);
      if (!triggered) {
        triggered = true;
        r.addEvent("triggered-from-subscriber"); // cursor 2
      }
    });

    expect(seen).toEqual([1]); // reentrant event NOT delivered to this cb
    expect(r.currentCursor).toBe(2); // but it IS in the buffer
    expect(r.oldestCursor).toBe(1);
  });
});
