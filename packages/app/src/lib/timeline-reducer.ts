import type {
  EventDelta,
  TimelineItem,
  TurnUsage,
} from "@sidecodeapp/protocol";

// Re-export so app-side consumers (lib/context-usage, hooks/use-context-
// usage) can import TurnUsage from one place. Was a local Extract<> alias
// before protocol exported the type directly.
export type { TurnUsage };

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
  /**
   * Usage snapshot from the most recent `turn_completed` delta. SDK's
   * `usage` per turn is cumulative-at-API-call (cache_read covers the
   * full prior context), so iOS treats it as "current context size" and
   * replaces — does NOT accumulate. `useContextUsage` reads this to
   * drive the meter fill on the model picker chip.
   *
   * `null` semantics — meter renders no fill:
   *   - Fresh subscribe to a session with no turns yet
   *   - Resumed session: settled snapshot never carries usage (JSONL
   *     replay produces TimelineItems only); the next live
   *     turn_completed populates this. Until then, no meter on resumes.
   *     Acceptable V0 trade — V0.5+ could surface JSONL last-usage via
   *     subscribe.response if useful.
   *   - Cleared on `applySettled` (subscribe re-snapshot) and
   *     `emptyTimelineState` (mount).
   */
  latestUsage: TurnUsage | null;
}

/** Fresh, empty state — used on first mount before subscribe() resolves. */
export function emptyTimelineState(): TimelineState {
  return {
    items: [],
    cursor: 0,
    isRunning: false,
    lastError: null,
    latestUsage: null,
  };
}

/**
 * Initialize from the daemon's `subscribe.response`. Settled items come
 * from the JSONL replay; cursor from the runtime's monotonic counter.
 * Always starts `isRunning: false` — even if a turn was in flight at
 * subscribe time, the next live `turn_started` delta will flip it back
 * to true.
 *
 * `initialUsage` is the daemon's resume-time seed for the context
 * meter — extracted from the JSONL's last assistant message envelope
 * so the meter renders something on session open rather than waiting
 * for the next live `turn_completed`. Undefined → meter stays null
 * (fresh session, or last turn was tool-only with no usage payload).
 */
export function applySettled(
  settled: readonly TimelineItem[],
  cursor: number,
  initialUsage?: TurnUsage,
): TimelineState {
  return {
    items: [...settled],
    cursor,
    isRunning: false,
    lastError: null,
    latestUsage: initialUsage ?? null,
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
      // `usage` is optional on the delta (daemon may omit when SDK
      // result envelope lacks it, e.g. error subtypes that don't route
      // here but defending anyway). Preserve prior usage in that case
      // — better to keep stale than drop the meter entirely.
      return {
        ...state,
        isRunning: false,
        cursor,
        latestUsage: delta.usage ?? state.latestUsage,
      };
    case "turn_failed":
      return { ...state, isRunning: false, lastError: delta.error, cursor };
    case "turn_canceled":
      return { ...state, isRunning: false, cursor };
    case "compact_started":
      // STUB — full handling (set isCompacting:true) lands in the next
      // Slice 2 commit. For now just keep cursor in sync so the switch
      // is exhaustive and we don't drop the delta on the floor; UI
      // doesn't show a banner yet because the state field isn't here.
      return { ...state, cursor };
    case "compact_applied":
      // STUB — full handling (prune items by preservedUuids, append
      // compact_divider TimelineItem, flip isCompacting:false) lands
      // in the next Slice 2 commit. Same cursor-only no-op as above.
      return { ...state, cursor };
  }
}
