/**
 * Application-layer chunking for WebRTC DataChannel.
 *
 * SCTP / libdatachannel / libwebrtc cap a single message at ~256 KiB
 * (the SDP-negotiated `max-message-size`, plus stricter limits in some
 * stacks). Sessions whose `subscribeResponse.settled[]` exceeds that
 * cap can't be opened — `dc.send()` throws `Message size exceeds
 * limit`. To handle this without a protocol schema bump or a
 * pagination redesign, we split the JSON payload into chunks at the
 * transport-wrapper level and reassemble on the other side.
 *
 * Wire shape: a chunked logical message is sent as N envelopes
 *
 *   { _c: "<chunkId>", _n: <total>, _d: "<slice 0>" }   // first only
 *   { _c: "<chunkId>",             _d: "<slice 1>" }
 *   { _c: "<chunkId>",             _d: "<slice ...>" }
 *
 * - `_c` chunk id — a process-wide counter, base36-encoded. Identifies
 *   which logical message a slice belongs to.
 * - `_n` total slice count — present ONLY on the first chunk; receiver
 *   primes its buffer from it.
 * - `_d` slice payload — a UTF-16 substring of the original JSON
 *   string. Sliced by character (not UTF-8 byte) for simplicity;
 *   threshold is conservative enough that even all-CJK content stays
 *   under the SCTP wire limit (60k chars × 3 bytes worst-case = 180k
 *   bytes, well below 256 KiB).
 *
 * Why we don't need `_i` (per-slice index): DataChannel is configured
 * `ordered: true` everywhere, so SCTP guarantees in-order delivery
 * (TSN + SSN reordering before delivery). The receiver simply pushes
 * each slice into an array and the order falls out of arrival.
 *
 * Underscore field names avoid colliding with application frames —
 * none of our Zod schemas use leading-underscore fields.
 */

/** Threshold in UTF-16 chars. Below this, send as-is (no chunking
 *  envelope, no reassembly overhead). Above, split. */
const CHUNK_THRESHOLD_CHARS = 60_000;

export interface ChunkEnvelope {
  _c: string;
  _n?: number;
  _d: string;
}

let nextChunkId = 0;

/** Tests only — reset the global counter. */
export function resetChunkIdCounterForTests(): void {
  nextChunkId = 0;
}

/**
 * Yield one or more wire strings for a single logical JSON message.
 * Short messages emit a single string (the JSON itself, no envelope).
 * Long messages emit N chunk envelopes, JSON-encoded.
 */
export function* chunkMessage(json: string): Generator<string> {
  if (json.length <= CHUNK_THRESHOLD_CHARS) {
    yield json;
    return;
  }
  const cid = (nextChunkId++).toString(36);
  const total = Math.ceil(json.length / CHUNK_THRESHOLD_CHARS);
  for (let i = 0; i < total; i++) {
    const slice = json.slice(
      i * CHUNK_THRESHOLD_CHARS,
      (i + 1) * CHUNK_THRESHOLD_CHARS,
    );
    const env: ChunkEnvelope =
      i === 0 ? { _c: cid, _n: total, _d: slice } : { _c: cid, _d: slice };
    yield JSON.stringify(env);
  }
}

/**
 * True if a parsed wire object looks like a chunk envelope. Use this
 * to fork: chunk envelopes go to `ChunkReassembler.push`; everything
 * else is a regular frame and dispatches as before.
 */
export function isChunkEnvelope(obj: unknown): obj is ChunkEnvelope {
  if (typeof obj !== "object" || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return typeof o._c === "string" && typeof o._d === "string";
}

interface Partial {
  total: number;
  parts: string[];
  firstSeenAt: number;
}

/**
 * Per-connection reassembly state. Buffers incoming chunks by `_c`
 * until `_n` slices have arrived, then returns the joined string. The
 * caller `JSON.parse`s the result and dispatches it like any other
 * frame.
 *
 * Each peer / connection should have its own instance — chunk ids are
 * scoped to a sender, and a stale buffer from a dropped connection
 * shouldn't leak into a fresh one.
 */
export class ChunkReassembler {
  private readonly partials = new Map<string, Partial>();

  /**
   * Feed one envelope. Returns the assembled JSON string the moment
   * the last slice arrives, or `null` while more are pending.
   *
   * Defensive cases:
   *   - First envelope missing `_n`: drop silently. Sender is
   *     malformed (we always set `_n` on the first chunk).
   *   - `_n` changes mid-stream: drop the buffer; sender bug.
   */
  push(env: ChunkEnvelope): string | null {
    let buf = this.partials.get(env._c);
    if (buf === undefined) {
      if (env._n === undefined) return null;
      buf = { total: env._n, parts: [], firstSeenAt: Date.now() };
      this.partials.set(env._c, buf);
    } else if (env._n !== undefined && env._n !== buf.total) {
      this.partials.delete(env._c);
      return null;
    }
    buf.parts.push(env._d);
    if (buf.parts.length === buf.total) {
      this.partials.delete(env._c);
      return buf.parts.join("");
    }
    return null;
  }

  /**
   * Drop any partial reassembly older than `maxAgeMs`. Call this
   * periodically (e.g. on a 60s interval) so a stalled send — peer
   * dies mid-stream, network blip — doesn't leak memory forever.
   */
  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let dropped = 0;
    for (const [id, buf] of this.partials) {
      if (buf.firstSeenAt < cutoff) {
        this.partials.delete(id);
        dropped += 1;
      }
    }
    return dropped;
  }

  /** Tests only. */
  partialCount(): number {
    return this.partials.size;
  }
}
