import { describe, expect, it } from "vitest";
import { SessionRuntimeManager } from "./session-runtime-manager.js";

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
