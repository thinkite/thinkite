import type { EventDelta, TimelineItem } from "@sidecodeapp/protocol";

/**
 * Per-session UI state derived from `EventDelta` stream + initial settled
 * snapshot. Pure value type — produced/transformed by `applySettled` and
 * `applyDelta` below; iOS view layer subscribes via React state setter
 * (the daemon-client subscribe() callback feeds applyDelta one-by-one).
 *
 * Why split state from the renderer:
 *   - Lets us unit-test the protocol → state translation as a pure
 *     function with mocked EventDelta sequences (this file).
 *   - Keeps the FlatList component (slice H2) free of branching logic
 *     for the 7 EventDelta variants — it just renders `items` + reads
 *     `isRunning` for the input bar's send/stop toggle.
 *
 * `cursor` is informational (debug + reconnect heuristics if we ever
 * implement reconnect-with-resume); not load-bearing for V0 rendering.
 */
export interface TimelineState {
  items: TimelineItem[];
  cursor: number;
  /**
   * True between `turn_started` and any terminal turn delta. Drives the
   * input-bar's stop/send button toggle and any "thinking..." indicator.
   */
  isRunning: boolean;
  /** Set on `turn_failed`; cleared on the next `turn_started`. */
  lastError: string | null;
}

/** Fresh, empty state — used on first mount before subscribe() resolves. */
export function emptyTimelineState(): TimelineState {
  return {
    items: [],
    cursor: 0,
    isRunning: false,
    lastError: null,
  };
}

/**
 * Initialize from the daemon's `subscribe.response`. Settled items come
 * from the JSONL replay; cursor from the runtime's monotonic counter.
 * Always starts `isRunning: false` — even if a turn was in flight at
 * subscribe time, the next live `turn_started` delta will flip it back
 * to true.
 */
export function applySettled(
  settled: readonly TimelineItem[],
  cursor: number,
): TimelineState {
  return {
    items: [...settled],
    cursor,
    isRunning: false,
    lastError: null,
  };
}

/**
 * Apply a single `EventDelta` to the timeline state. Pure function: the
 * input state is never mutated; a new TimelineState is returned every
 * call (React reactivity requires fresh references).
 *
 * Defensive no-ops:
 *   - `patch_text` against a missing uuid → ignored (no item to mutate)
 *   - `patch_tool_call` against a missing callId → ignored
 * These shouldn't happen in practice (daemon emits patches only for
 * items it appended itself), but defending here prevents subtle
 * crashes if e.g. a buggy reorder ever lands.
 */
export function applyDelta(
  state: TimelineState,
  delta: EventDelta,
  cursor: number,
): TimelineState {
  switch (delta.kind) {
    case "append":
      return {
        ...state,
        items: [...state.items, delta.item],
        cursor,
      };
    case "patch_text":
      return {
        ...state,
        items: state.items.map((item) =>
          item.type === "assistant_message" && item.uuid === delta.uuid
            ? { ...item, text: item.text + delta.deltaText }
            : item,
        ),
        cursor,
      };
    case "patch_tool_call":
      return {
        ...state,
        items: state.items.map((item) =>
          item.type === "tool_call" && item.callId === delta.callId
            ? {
                ...item,
                status: delta.status,
                error: delta.error,
                detail: delta.detail,
              }
            : item,
        ),
        cursor,
      };
    case "turn_started":
      return { ...state, isRunning: true, lastError: null, cursor };
    case "turn_completed":
      return { ...state, isRunning: false, cursor };
    case "turn_failed":
      return { ...state, isRunning: false, lastError: delta.error, cursor };
    case "turn_canceled":
      return { ...state, isRunning: false, cursor };
  }
}
