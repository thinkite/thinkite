import { beforeEach, describe, expect, it } from "vitest";
import {
  type ChunkEnvelope,
  ChunkReassembler,
  chunkMessage,
  isChunkEnvelope,
  resetChunkIdCounterForTests,
} from "./chunking.js";

describe("chunkMessage", () => {
  beforeEach(() => {
    resetChunkIdCounterForTests();
  });

  it("yields the original string unchanged when below the threshold", () => {
    const small = JSON.stringify({ type: "ping", t: 1 });
    const out = Array.from(chunkMessage(small));
    expect(out).toEqual([small]);
  });

  it("splits into envelopes only when the threshold is crossed", () => {
    // Build a string just over the 60_000-char threshold. Two chunks
    // is the minimum interesting case (envelope shapes diverge between
    // the first and the rest).
    const payload = "a".repeat(60_001);
    const out = Array.from(chunkMessage(payload));
    expect(out.length).toBe(2);
    const first = JSON.parse(out[0]) as ChunkEnvelope;
    const rest = JSON.parse(out[1]) as ChunkEnvelope;
    expect(first._c).toBe(rest._c);
    expect(first._n).toBe(2);
    expect(rest._n).toBeUndefined();
    expect(first._d).toHaveLength(60_000);
    expect(rest._d).toHaveLength(1);
  });

  it("uses a distinct chunk id per call", () => {
    const payload = "x".repeat(60_001);
    const a = JSON.parse(Array.from(chunkMessage(payload))[0]) as ChunkEnvelope;
    const b = JSON.parse(Array.from(chunkMessage(payload))[0]) as ChunkEnvelope;
    expect(a._c).not.toBe(b._c);
  });

  it("preserves payload when reassembled from its own chunks", () => {
    // 3.5 chunks worth — exercises the floor/ceil edge.
    const payload = "z".repeat(210_000);
    const reassembler = new ChunkReassembler();
    let assembled: string | null = null;
    for (const wire of chunkMessage(payload)) {
      const env = JSON.parse(wire) as ChunkEnvelope;
      assembled = reassembler.push(env);
    }
    expect(assembled).toBe(payload);
    expect(reassembler.partialCount()).toBe(0);
  });
});

describe("isChunkEnvelope", () => {
  it("recognises chunk envelopes regardless of `_n`", () => {
    expect(isChunkEnvelope({ _c: "1", _n: 3, _d: "abc" })).toBe(true);
    expect(isChunkEnvelope({ _c: "1", _d: "def" })).toBe(true);
  });

  it("rejects regular application frames", () => {
    expect(isChunkEnvelope({ type: "ping", t: 1 })).toBe(false);
    expect(isChunkEnvelope({ type: "subscribe", requestId: "x" })).toBe(false);
    expect(isChunkEnvelope(null)).toBe(false);
    expect(isChunkEnvelope(undefined)).toBe(false);
    expect(isChunkEnvelope("string")).toBe(false);
  });

  it("rejects malformed envelopes", () => {
    // Missing _d
    expect(isChunkEnvelope({ _c: "1", _n: 3 })).toBe(false);
    // Wrong type on _c
    expect(isChunkEnvelope({ _c: 42, _d: "x" })).toBe(false);
  });
});

describe("ChunkReassembler", () => {
  it("returns null until the last chunk arrives", () => {
    const r = new ChunkReassembler();
    expect(r.push({ _c: "1", _n: 3, _d: "a" })).toBeNull();
    expect(r.push({ _c: "1", _d: "b" })).toBeNull();
    expect(r.push({ _c: "1", _d: "c" })).toBe("abc");
  });

  it("clears the buffer after a complete assembly", () => {
    const r = new ChunkReassembler();
    r.push({ _c: "1", _n: 2, _d: "x" });
    r.push({ _c: "1", _d: "y" });
    expect(r.partialCount()).toBe(0);
    // A fresh message with the same id (would be a sender bug, but
    // shouldn't crash) starts a new buffer.
    expect(r.push({ _c: "1", _n: 2, _d: "p" })).toBeNull();
    expect(r.partialCount()).toBe(1);
  });

  it("interleaves multiple in-flight messages by chunk id", () => {
    // SCTP ordering guarantees we don't interleave WITHIN a peer for
    // a single sender, but multiple loosely related sends could
    // theoretically interleave at the application layer if someone
    // ever runs concurrent senders. Verify we still demux by `_c`.
    const r = new ChunkReassembler();
    expect(r.push({ _c: "a", _n: 2, _d: "1" })).toBeNull();
    expect(r.push({ _c: "b", _n: 2, _d: "x" })).toBeNull();
    expect(r.push({ _c: "a", _d: "2" })).toBe("12");
    expect(r.push({ _c: "b", _d: "y" })).toBe("xy");
  });

  it("drops a mid-stream chunk without prior _n (malformed)", () => {
    const r = new ChunkReassembler();
    // First envelope arrives without _n — sender bug. Drop silently.
    expect(r.push({ _c: "1", _d: "orphan" })).toBeNull();
    expect(r.partialCount()).toBe(0);
  });

  it("drops the buffer if _n changes mid-stream", () => {
    const r = new ChunkReassembler();
    r.push({ _c: "1", _n: 3, _d: "a" });
    // Second envelope retransmits a different _n — protocol error.
    expect(r.push({ _c: "1", _n: 4, _d: "b" })).toBeNull();
    expect(r.partialCount()).toBe(0);
  });

  it("prune drops stale partials older than maxAgeMs", async () => {
    const r = new ChunkReassembler();
    r.push({ _c: "1", _n: 5, _d: "a" });
    expect(r.partialCount()).toBe(1);
    // Sleep just long enough for the firstSeenAt timestamp to age.
    await new Promise((res) => setTimeout(res, 10));
    expect(r.prune(5)).toBe(1);
    expect(r.partialCount()).toBe(0);
  });

  it("prune keeps fresh partials", () => {
    const r = new ChunkReassembler();
    r.push({ _c: "1", _n: 5, _d: "a" });
    // No sleep — partial is well under the maxAge.
    expect(r.prune(60_000)).toBe(0);
    expect(r.partialCount()).toBe(1);
  });
});
