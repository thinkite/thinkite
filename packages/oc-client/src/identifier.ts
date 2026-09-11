/**
 * Client-side opencode identifiers. The v2 prompt route accepts a
 * caller-supplied `id` (echoed back as `messageID` on `prompt.admitted`,
 * which is how the optimistic user bubble reconciles) but validates the
 * prefix — a UUID is rejected with `Expected a string starting with
 * "msg_"`. Mirrors `packages/schema/src/identifier.ts` upstream: 12 hex
 * chars of (timestamp * 4096 + counter) so ids sort by time, then 14
 * random base62 chars. Same generator the server uses, so our ids sort
 * correctly next to server-minted ones.
 */

const LENGTH = 26;
const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let lastTimestamp = 0;
let counter = 0;

function ascending(timestamp = Date.now()): string {
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp;
    counter = 0;
  }
  counter += 1;
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter);
  let time = "";
  for (let index = 0; index < 6; index += 1) {
    time += Number((current >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(LENGTH - 12));
  let random = "";
  for (const byte of bytes) random += CHARS[byte % 62];
  return time + random;
}

/** A `msg_*` id acceptable to `POST /api/session/:id/prompt` `{ id }`. */
export function mintMessageId(): string {
  return `msg_${ascending()}`;
}
