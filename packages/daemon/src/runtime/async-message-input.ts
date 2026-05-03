/**
 * Async push channel adapted to the AsyncIterable shape the SDK's
 * `query({ prompt: AsyncIterable<SDKUserMessage> })` expects. Producers
 * call `push(msg)` whenever a new prompt arrives; the consumer (SDK
 * subprocess) pulls via the iterable. `end()` signals no more prompts —
 * SDK winds down gracefully after the current turn.
 *
 * Why streaming-input mode instead of single-shot string prompt:
 *   - SDK's `interrupt()` only works in streaming-input mode (per
 *     sdk.d.ts:2018-2027 — "Control Requests… only supported when
 *     streaming input/output is used"). String mode would leave our F3
 *     "stop" button dead.
 *   - One persistent `claude` subprocess per session vs respawn per
 *     prompt — saves the 1-2s cold start + context reload each turn.
 *   - Matches Paseo's pattern (claude-agent.ts:2109-2113); we ported the
 *     channel utility from there with simplifications (no return-value,
 *     no priority queue).
 *
 * Semantics:
 *   - push when no consumer is waiting → enqueue
 *   - push when a consumer awaits next() → resolve immediately
 *   - end → all waiting consumers get `{done: true}`; subsequent push
 *     calls are no-ops (channel is closed)
 *   - iterable produces a fresh AsyncIterator per `[Symbol.asyncIterator]`
 *     call; in practice we only consume once (passed to `query()`)
 */

export interface AsyncMessageInput<T> {
  /** Enqueue or hand off to a waiting consumer. No-op once `end()` was called. */
  push(msg: T): void;
  /** Mark the stream finished. Consumers waiting on `next()` get `done: true`. */
  end(): void;
  /** AsyncIterable side — pass directly to SDK's `query({ prompt })`. */
  iterable: AsyncIterable<T>;
}

export function createAsyncMessageInput<T>(): AsyncMessageInput<T> {
  const queue: T[] = [];
  const waiters: Array<(result: IteratorResult<T, void>) => void> = [];
  let closed = false;

  return {
    push(msg: T) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: msg, done: false });
        return;
      }
      queue.push(msg);
    },
    end() {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift();
        waiter?.({ value: undefined, done: true });
      }
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<T, void> {
        return {
          next(): Promise<IteratorResult<T, void>> {
            if (queue.length > 0) {
              const value = queue.shift() as T;
              return Promise.resolve({ value, done: false });
            }
            if (closed) {
              return Promise.resolve({ value: undefined, done: true });
            }
            return new Promise<IteratorResult<T, void>>((resolve) => {
              waiters.push(resolve);
            });
          },
        };
      },
    },
  };
}
