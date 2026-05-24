/**
 * One-shot prompt handoff between the new-session screen and the detail
 * screen. The new-session screen generates a UUID, stashes the prompt
 * here, and navigates immediately. The detail screen subscribes via
 * `useLiveSession`, and once that subscribe is fully registered on the
 * daemon (`isInitialLoading === false`), it consumes the entry and fires
 * `sendPrompt`.
 *
 * Why this and not `client.sendPrompt(...).then(navigate)` directly:
 *   - sendPrompt-then-nav has perceptible RTT lag before the user sees
 *     the detail screen
 *   - nav-then-sendPrompt-from-new-session-screen races on the wire:
 *     the `subscribe` and `sendPrompt` WS messages can interleave on
 *     the daemon side (subscribe reads `runtime.currentCursor` AFTER
 *     pushPrompt advances it → the user_message + turn_started events
 *     fall into a gap and never reach the iOS subscriber)
 *   - waiting for subscribe.response from iOS before firing sendPrompt
 *     guarantees daemon has registered the live fanout callback
 *
 * Why a module-level Map instead of route params:
 *   - prompts can be paragraph-sized; url-encoding multi-line input into
 *     route params is fragile and shows up in nav-stack diagnostics
 *   - one-shot consume semantics map naturally onto Map.delete()
 *
 * Why no Zustand / context:
 *   - cross-component, no subscription needed (writer fires once, reader
 *     consumes once and won't re-render on changes)
 *   - keeping the reader local to the detail screen's effect avoids
 *     React state-vs-effect ordering puzzles
 */
import type { ImageAttachment } from "@sidecodeapp/protocol";

type PendingPrompt = {
  text: string;
  cwd: string;
  /** Compressed base64 attachments to forward as the first sendPrompt's
   *  `images` payload. Undefined / empty for text-only first prompts. */
  images?: ImageAttachment[];
};

const pending = new Map<string, PendingPrompt>();

export function setPendingPrompt(
  cliSessionId: string,
  entry: PendingPrompt,
): void {
  pending.set(cliSessionId, entry);
}

/**
 * Atomic take: returns the entry and removes it. Subsequent calls for
 * the same id return undefined. Idempotent for callers that protect
 * against double-fire with a ref — both layers are fine.
 */
export function consumePendingPrompt(
  cliSessionId: string,
): PendingPrompt | undefined {
  const entry = pending.get(cliSessionId);
  if (entry) pending.delete(cliSessionId);
  return entry;
}
