import { describe, expect, it, vi } from "vitest";
import type { RuntimeQueryHandle } from "./session-runtime.js";
import { SessionRuntimeManager } from "./session-runtime-manager.js";

function fakeQuery(): RuntimeQueryHandle & {
  closeMock: ReturnType<typeof vi.fn>;
} {
  const closeMock = vi.fn();
  return {
    interrupt: async () => {},
    close: closeMock,
    closeMock,
  };
}

describe("SessionRuntimeManager", () => {
  it("getOrCreate creates a new runtime if absent", () => {
    const m = new SessionRuntimeManager<string>();
    expect(m.has("s1")).toBe(false);
    const r = m.getOrCreate("s1");
    expect(r.sessionId).toBe("s1");
    expect(m.has("s1")).toBe(true);
    expect(m.size()).toBe(1);
  });

  it("getOrCreate returns the existing runtime on subsequent calls", () => {
    const m = new SessionRuntimeManager<string>();
    const a = m.getOrCreate("s1");
    a.addEvent("event-on-a");
    const b = m.getOrCreate("s1");
    expect(b).toBe(a);
    expect(b.currentCursor).toBe(1); // state preserved
  });

  it("delete removes; returns true iff it existed", () => {
    const m = new SessionRuntimeManager<string>();
    m.getOrCreate("s1");
    expect(m.delete("s1")).toBe(true);
    expect(m.delete("s1")).toBe(false);
    expect(m.has("s1")).toBe(false);
  });

  it("values() iterates all live runtimes", () => {
    const m = new SessionRuntimeManager<string>();
    m.getOrCreate("a");
    m.getOrCreate("b");
    m.getOrCreate("c");
    const ids = [...m.values()].map((r) => r.sessionId).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("default options propagate to lazily-created runtimes", () => {
    const m = new SessionRuntimeManager<string>({ bufferCap: 2 });
    const r = m.getOrCreate("s1");
    r.addEvent("a"); // cursor 1
    r.addEvent("b"); // cursor 2
    r.addEvent("c"); // cursor 3 — "a" evicted by cap=2
    expect(r.oldestCursor).toBe(2);
  });

  it("options passed to getOrCreate override defaults on first creation only", () => {
    const m = new SessionRuntimeManager<string>({ bufferCap: 100 });
    const r = m.getOrCreate("s1", { bufferCap: 1 });
    r.addEvent("a"); // cursor 1
    r.addEvent("b"); // cursor 2 — "a" evicted by cap=1
    expect(r.oldestCursor).toBe(2);

    // Subsequent getOrCreate with different options is ignored.
    const r2 = m.getOrCreate("s1", { bufferCap: 1000 });
    expect(r2).toBe(r);
    r2.addEvent("c"); // cursor 3 — still cap=1
    expect(r2.oldestCursor).toBe(3);
  });
});

describe("SessionRuntimeManager.shutdown", () => {
  it("resolves immediately on an empty manager", async () => {
    const m = new SessionRuntimeManager<string>();
    const start = Date.now();
    await m.shutdown(5000);
    expect(Date.now() - start).toBeLessThan(50);
  });

  it("calls close() on every runtime's query in parallel", async () => {
    const m = new SessionRuntimeManager<string>();
    const r1 = m.getOrCreate("s1");
    const r2 = m.getOrCreate("s2");
    const r3 = m.getOrCreate("s3");
    const q1 = fakeQuery();
    const q2 = fakeQuery();
    const q3 = fakeQuery();
    r1.query = q1;
    r2.query = q2;
    r3.query = q3;
    // No loopPromise → shutdown skips await (no-op for that runtime).
    await m.shutdown(1000);
    expect(q1.closeMock).toHaveBeenCalledOnce();
    expect(q2.closeMock).toHaveBeenCalledOnce();
    expect(q3.closeMock).toHaveBeenCalledOnce();
  });

  it("awaits each runtime's loopPromise before resolving", async () => {
    const m = new SessionRuntimeManager<string>();
    const r = m.getOrCreate("s1");
    r.query = fakeQuery();
    let resolved = false;
    r.loopPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        resolved = true;
        resolve();
      }, 30);
    });
    await m.shutdown(1000);
    expect(resolved).toBe(true);
  });

  it("clears the map after shutdown so subsequent has/get/size show empty", async () => {
    const m = new SessionRuntimeManager<string>();
    m.getOrCreate("s1");
    m.getOrCreate("s2");
    expect(m.size()).toBe(2);
    await m.shutdown(100);
    expect(m.size()).toBe(0);
    expect(m.has("s1")).toBe(false);
    expect(m.get("s2")).toBeUndefined();
  });

  it("does NOT hang when loopPromise never resolves — bounded by timeoutMs", async () => {
    const m = new SessionRuntimeManager<string>();
    const r = m.getOrCreate("s1");
    r.query = fakeQuery();
    // Promise that never resolves.
    r.loopPromise = new Promise<void>(() => {});
    const start = Date.now();
    await m.shutdown(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40); // ~50ms timer fired
    expect(elapsed).toBeLessThan(200); // didn't hang
    // Map cleared regardless of timeout.
    expect(m.size()).toBe(0);
  });

  it("tolerates runtime without a query (just buffer state)", async () => {
    const m = new SessionRuntimeManager<string>();
    const r = m.getOrCreate("s1");
    r.addEvent("event-but-no-query");
    expect(r.query).toBeNull();
    await expect(m.shutdown(100)).resolves.toBeUndefined();
    expect(m.size()).toBe(0);
  });

  it("tolerates runtime without a loopPromise (close fired, no await)", async () => {
    const m = new SessionRuntimeManager<string>();
    const r = m.getOrCreate("s1");
    const q = fakeQuery();
    r.query = q;
    // loopPromise stays null
    await m.shutdown(100);
    expect(q.closeMock).toHaveBeenCalledOnce();
  });

  it("swallows rejected loopPromise so shutdown still completes", async () => {
    const m = new SessionRuntimeManager<string>();
    const r = m.getOrCreate("s1");
    r.query = fakeQuery();
    r.loopPromise = Promise.reject(new Error("loop blew up"));
    // Should not throw.
    await expect(m.shutdown(100)).resolves.toBeUndefined();
    expect(m.size()).toBe(0);
  });

  it("swallows close() exceptions per-runtime — others still drained", async () => {
    const m = new SessionRuntimeManager<string>();
    const r1 = m.getOrCreate("s1");
    const r2 = m.getOrCreate("s2");
    r1.query = {
      interrupt: async () => {},
      close: () => {
        throw new Error("close blew up");
      },
    };
    const q2 = fakeQuery();
    r2.query = q2;
    await expect(m.shutdown(100)).resolves.toBeUndefined();
    expect(q2.closeMock).toHaveBeenCalledOnce();
    expect(m.size()).toBe(0);
  });
});
