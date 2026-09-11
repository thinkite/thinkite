/**
 * The opencode counterpart of `runtime/run-query.ts` (`ensureSessionLoop` /
 * `pushPrompt` / interrupt): one long-lived per-session event stream feeding
 * `runtime.addEvent`, with the same public contract towards `index.ts` +
 * `router.ts` so call sites only branch on `THINKITE_AGENT_HOST`.
 *
 * Turn lifecycle on this host:
 *   - `pushOpencodePrompt` emits `turn_started` synchronously, then POSTs
 *     the prompt (with `resume: true` when a previous stream died
 *     mid-turn). The `user_message` append arrives via the admitted event
 *     (never synthesized — the log echoes every prompt).
 *   - One prompt drives MULTIPLE steps (observed live), so `step.ended`
 *     is not a turn end. A waiter polls `activeSessions()` until the
 *     session goes idle, then catches up via `history?after=` (covers the
 *     race between idle and stream delivery) and emits `turn_completed`
 *     with the stashed usage — or `turn_failed` when the tail is a
 *     `step.failed`.
 *   - `interruptOpencode` mirrors the router's interrupt semantics:
 *     synchronously flag `runtime.interrupted`, POST the interrupt, emit
 *     `turn_canceled`. The turn's terminal `step.failed` ("Provider turn
 *     interrupted") is swallowed by the flag.
 *
 * Identity: Thinkite session ids key runtimes/buffers/metadata; the
 * server-minted `ses_*` id lives in metadata (`opencodeSessionId`) and
 * keys every opencode call. The v2 SessionID brand requires the `ses_`
 * prefix, so the Thinkite id cannot be reused server-side.
 */

import type { EventDelta, ImageAttachment } from "@thinkite/protocol";
import type { SessionRuntime } from "../runtime/session-runtime.ts";
import type { SessionRuntimeManager } from "../runtime/session-runtime-manager.ts";
import {
  OpencodeApiError,
  type OpencodeClient,
  type OpencodeDurableEvent,
  type OpencodeLiveEvent,
} from "./client.ts";
import { type OpencodeHost, resolveOpencodeModel } from "./host.ts";
import {
  createOpencodeLiveState,
  mapOpencodeLiveEvent,
  normalizeOpencodeHistory,
  type OpencodeLiveState,
} from "./normalize-opencode.ts";

const ACTIVE_POLL_MS = 500;
const TURN_TIMEOUT_MS = 10 * 60_000;
const HISTORY_PAGE = 100;

export interface OpencodePromptInput {
  text: string;
  images?: readonly ImageAttachment[];
  userMessageUuid?: string;
  cwd?: string;
  /** Picker model (`providerID/modelID`); creation-only, like run-query. */
  model?: string;
}

export interface OpencodeLoop {
  thinkiteSessionId: string;
  opencodeSessionId: string;
  client: OpencodeClient;
  live: OpencodeLiveState;
  /** Last durable seq consumed (stream resume point). */
  lastSeq: number;
  streamAbort: AbortController | null;
  streamState: "opening" | "open" | "dead";
  detachLive: (() => void) | null;
  waiter: Promise<void> | null;
  turnActive: boolean;
  turnSettled: boolean;
  needsResume: boolean;
  pendingUserUuid: string | null;
  disposed: boolean;
}

const loops = new Map<string, OpencodeLoop>();

/** Refresh + return the loop's client (auth rotates on server respawn). */
export function opencodeLoopClient(
  host: OpencodeHost,
  loop: OpencodeLoop,
): OpencodeClient {
  refreshClient(host, loop);
  return loop.client;
}

function loopLog(msg: string): void {
  console.log(`[sidecode] ${msg}`);
}

/**
 * Idempotent. Resolves (creating the server session + metadata on first
 * call) and ensures the event stream is opening. Never throws for
 * stream-open races — the stream heals in the background; prompt admission
 * is independent of it.
 */
export async function ensureOpencodeLoop(
  manager: SessionRuntimeManager<EventDelta>,
  host: OpencodeHost,
  runtime: SessionRuntime<EventDelta>,
  input: OpencodePromptInput,
): Promise<OpencodeLoop> {
  const existing = loops.get(runtime.sessionId);
  if (existing !== undefined && !existing.disposed) {
    openStream(manager, host, existing);
    return existing;
  }
  const client = await host.start();
  const meta = manager.getMetadata(runtime.sessionId);
  let opencodeSessionId = meta?.opencodeSessionId;
  if (opencodeSessionId !== undefined) {
    // Mapping recorded but the server may have forgotten (data wipe) —
    // fall through to create when the lookup misses.
    const found = await client
      .getSession(opencodeSessionId)
      .catch(() => undefined);
    if (found === undefined) opencodeSessionId = undefined;
  }
  if (opencodeSessionId === undefined) {
    const cwd = input.cwd ?? meta?.cwd;
    if (cwd === undefined) {
      throw new Error(
        "cwd is required when sendPrompt creates a new session " +
          "(no opencode session exists for this sessionId yet)",
      );
    }
    const created = await client.createSession({
      directory: cwd,
      model: resolveOpencodeModel(input.model ?? meta?.model),
      agent: "build",
    });
    opencodeSessionId = created.id;
    if (meta === undefined) {
      manager.createSessionFromPrompt({
        cliSessionId: runtime.sessionId,
        cwd,
        firstPrompt: input.text,
        ...(input.model !== undefined ? { model: input.model } : {}),
        host: "opencode",
        opencodeSessionId,
      });
    } else {
      // Pre-existing metadata without a mapping (e.g. written before the
      // opencode host existed): persist the mapping in place.
      manager.attachOpencodeSession(runtime.sessionId, opencodeSessionId);
    }
  }
  const loop: OpencodeLoop = {
    thinkiteSessionId: runtime.sessionId,
    opencodeSessionId,
    client,
    live: createOpencodeLiveState(),
    lastSeq: 0,
    streamAbort: null,
    streamState: "dead",
    detachLive: null,
    waiter: null,
    turnActive: false,
    turnSettled: false,
    needsResume: false,
    pendingUserUuid: null,
    disposed: false,
  };
  loops.set(runtime.sessionId, loop);
  openStream(manager, host, loop);
  return loop;
}

// ─── Streaming ───────────────────────────────────────────────────────

/** Prefer the host's live client (auth rotates on every server respawn). */
function refreshClient(host: OpencodeHost, loop: OpencodeLoop): void {
  const live = host.client;
  if (live !== null) loop.client = live;
}

function openStream(
  manager: SessionRuntimeManager<EventDelta>,
  host: OpencodeHost,
  loop: OpencodeLoop,
): void {
  if (loop.disposed || loop.streamState !== "dead") return;
  refreshClient(host, loop);
  const client = loop.client;
  loop.streamState = "opening";
  const abort = new AbortController();
  loop.streamAbort = abort;
  loop.detachLive?.();
  loop.detachLive = host.onLiveDelta(loop.opencodeSessionId, (e) =>
    feedLive(manager, loop, e),
  );
  void client
    .subscribeSession(
      loop.opencodeSessionId,
      loop.lastSeq,
      (e) => feedDurable(manager, loop, e),
      abort.signal,
    )
    .then(({ done }) => {
      if (loop.streamAbort !== abort || loop.disposed) return;
      loop.streamState = "open";
      void done.then(() => {
        if (loop.streamAbort !== abort || loop.disposed) return;
        // Stream ended (server restart / network cut). The waiter keeps
        // polling; reopen with resume so the next prompt continues.
        loop.streamState = "dead";
        loop.streamAbort = null;
        loop.needsResume = true;
        if (loop.turnActive) openStream(manager, host, loop);
      });
    })
    .catch(() => {
      if (loop.streamAbort !== abort || loop.disposed) return;
      loop.streamState = "dead";
      loop.streamAbort = null;
      // Headers timeout on a quiet tail is normal (lazy SSE headers) —
      // retry while a turn is active, else lazily on the next prompt.
      if (loop.turnActive) {
        setTimeout(() => {
          if (!loop.disposed && loop.turnActive) {
            openStream(manager, host, loop);
          }
        }, 1000);
      }
    });
}

function runtimeOf(
  manager: SessionRuntimeManager<EventDelta>,
  loop: OpencodeLoop,
): SessionRuntime<EventDelta> | undefined {
  return manager.get(loop.thinkiteSessionId);
}

function feedDurable(
  manager: SessionRuntimeManager<EventDelta>,
  loop: OpencodeLoop,
  e: OpencodeDurableEvent,
): void {
  if (loop.disposed) return;
  if (e.durable !== undefined && e.durable.seq > loop.lastSeq) {
    loop.lastSeq = e.durable.seq;
  }
  feedMapped(manager, loop, e.type, e.data);
}

function feedLive(
  manager: SessionRuntimeManager<EventDelta>,
  loop: OpencodeLoop,
  e: OpencodeLiveEvent,
): void {
  if (loop.disposed) return;
  // Only text fragments are display deltas; tool input fragments are
  // partial JSON (the full input arrives on `tool.called`).
  if (e.type !== "session.next.text.delta") return;
  feedMapped(manager, loop, e.type, e.data);
}

function feedMapped(
  manager: SessionRuntimeManager<EventDelta>,
  loop: OpencodeLoop,
  type: string,
  data: Record<string, unknown>,
): void {
  const runtime = runtimeOf(manager, loop);
  if (runtime === undefined) return;
  let delta: EventDelta | null;
  const messageID =
    typeof data.messageID === "string" ? data.messageID : undefined;
  if (
    loop.pendingUserUuid !== null &&
    messageID !== undefined &&
    (type === "session.next.prompt.admitted" ||
      type === "session.next.prompted")
  ) {
    delta = mapOpencodeLiveEvent({ type, data }, loop.live, {
      userMessageUuids: new Map([[messageID, loop.pendingUserUuid]]),
    });
    if (loop.live.seenPrompts.has(messageID)) loop.pendingUserUuid = null;
  } else {
    delta = mapOpencodeLiveEvent({ type, data }, loop.live);
  }
  if (delta === null) return;
  if (delta.kind === "turn_failed") {
    // The interrupt path already emitted `turn_canceled` (and set the
    // flag); a settled turn must not emit twice.
    if (runtime.interrupted || loop.turnSettled) return;
    loop.turnSettled = true;
  }
  runtime.addEvent(delta);
}

// ─── Prompts ─────────────────────────────────────────────────────────

/**
 * Drive one user turn: `turn_started` now, prompt admission, then an
 * idle-waiter that settles the turn. Never rejects for opencode failures —
 * they surface as `turn_failed` (mirrors run-query's catch mapping).
 */
export async function pushOpencodePrompt(
  manager: SessionRuntimeManager<EventDelta>,
  host: OpencodeHost,
  runtime: SessionRuntime<EventDelta>,
  loop: OpencodeLoop,
  input: OpencodePromptInput,
): Promise<void> {
  runtime.interrupted = false;
  refreshClient(host, loop);
  loop.turnActive = true;
  loop.turnSettled = false;
  if (input.userMessageUuid !== undefined) {
    loop.pendingUserUuid = input.userMessageUuid;
  }
  runtime.addEvent({ kind: "turn_started" });
  markRunning(runtime);
  openStream(manager, host, loop);

  try {
    const files =
      input.images !== undefined && input.images.length > 0
        ? input.images.map((img, i) => ({
            // `data:` URIs are the server's own inline-blob convention
            // (session/prompt.ts builds `data:<mime>;base64,…` for parts).
            uri: `data:${img.mediaType};base64,${img.data}`,
            mime: img.mediaType,
            name: `image-${i}`,
          }))
        : undefined;
    await loop.client.prompt(loop.opencodeSessionId, input.text, {
      ...(loop.needsResume ? { resume: true } : {}),
      ...(files !== undefined ? { files } : {}),
    });
    loop.needsResume = false;
  } catch (err) {
    if (err instanceof OpencodeApiError && err.status === 404) {
      // Server forgot the session (data wipe): recreate + retry once.
      loopLog(`opencode session gone, recreating ${loop.thinkiteSessionId}`);
      loops.delete(loop.thinkiteSessionId);
      loop.disposed = true;
      loop.streamAbort?.abort();
      loop.detachLive?.();
      try {
        const fresh = await ensureOpencodeLoop(manager, host, runtime, input);
        await pushOpencodePrompt(manager, host, runtime, fresh, {
          ...input,
          userMessageUuid: undefined,
        });
      } catch (retryErr) {
        failTurn(manager, loop, retryErr);
      }
      return;
    }
    failTurn(manager, loop, err);
    return;
  }
  ensureWaiter(manager, host, loop);
}

function failTurn(
  manager: SessionRuntimeManager<EventDelta>,
  loop: OpencodeLoop,
  err: unknown,
): void {
  const runtime = runtimeOf(manager, loop);
  if (runtime === undefined || loop.turnSettled) return;
  loop.turnSettled = true;
  loop.turnActive = false;
  runtime.addEvent({
    kind: "turn_failed",
    error: err instanceof Error ? err.message : String(err),
  });
  markIdle(runtime);
}

// ─── Turn waiter (idleness → catch-up → settle) ──────────────────────

function ensureWaiter(
  manager: SessionRuntimeManager<EventDelta>,
  host: OpencodeHost,
  loop: OpencodeLoop,
): void {
  if (loop.waiter !== null) return;
  loop.waiter = waitForIdle(manager, host, loop).finally(() => {
    loop.waiter = null;
  });
}

async function waitForIdle(
  manager: SessionRuntimeManager<EventDelta>,
  host: OpencodeHost,
  loop: OpencodeLoop,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (loop.disposed) return;
    refreshClient(host, loop);
    if (Date.now() - started > TURN_TIMEOUT_MS) {
      failTurn(manager, loop, new Error("opencode turn timed out"));
      return;
    }
    let active: Record<string, { type: string }>;
    try {
      active = await loop.client.activeSessions();
    } catch {
      // Transient (server restarting) — keep polling; the stream reopen
      // path sets needsResume so the next prompt continues the turn.
      await sleep(ACTIVE_POLL_MS);
      continue;
    }
    if (Object.hasOwn(active, loop.opencodeSessionId)) {
      await sleep(ACTIVE_POLL_MS);
      continue;
    }
    // Idle — but the stream may lag behind the drain. Catch up through
    // history (durable, ordered) before settling the turn. Any `step.failed`
    // in the window flows through feedMapped → `turn_failed` (and settles
    // the turn), so reaching here means the turn completed.
    await catchUp(manager, loop);
    if (loop.disposed) return;
    const runtime = runtimeOf(manager, loop);
    if (runtime === undefined) return;
    if (loop.turnSettled) {
      loop.turnActive = false;
      return;
    }
    loop.turnSettled = true;
    loop.turnActive = false;
    const usage = loop.live.lastUsage;
    runtime.addEvent({
      kind: "turn_completed",
      ...(usage !== undefined ? { usage: { ...usage } } : {}),
    });
    if (usage !== undefined) runtime.latestUsage = { ...usage };
    markIdle(runtime);
    return;
  }
}

async function catchUp(
  manager: SessionRuntimeManager<EventDelta>,
  loop: OpencodeLoop,
): Promise<void> {
  // One page is the common case; follow `hasMore` for long turns.
  for (;;) {
    let page: { events: OpencodeDurableEvent[]; hasMore: boolean };
    try {
      page = await loop.client.history(
        loop.opencodeSessionId,
        loop.lastSeq,
        HISTORY_PAGE,
      );
    } catch {
      return;
    }
    for (const e of page.events) feedDurable(manager, loop, e);
    if (!page.hasMore || page.events.length === 0) return;
  }
}

// ─── Interrupt / history / delete ────────────────────────────────────

export async function interruptOpencode(
  manager: SessionRuntimeManager<EventDelta>,
  loop: OpencodeLoop,
): Promise<void> {
  const runtime = runtimeOf(manager, loop);
  if (runtime === undefined) return;
  // Flag FIRST (synchronously, before the await) so the in-flight turn's
  // terminal `step.failed` is recognized as the cancel — mirrors the
  // router's interrupt handler for the SDK path.
  runtime.interrupted = true;
  loop.turnSettled = true;
  try {
    await loop.client.interrupt(loop.opencodeSessionId);
  } catch (err) {
    loopLog(`opencode interrupt failed: ${errMessage(err)}`);
  }
  runtime.addEvent({ kind: "turn_canceled" });
}

export function getOpencodeLoop(sessionId: string): OpencodeLoop | undefined {
  return loops.get(sessionId);
}

/** Cold-start transcript for an opencode session (history → normalize). */
export async function opencodeColdStart(
  client: OpencodeClient,
  opencodeSessionId: string,
): Promise<{
  items: ReturnType<typeof normalizeOpencodeHistory>["items"];
  initialUsage?: ReturnType<typeof normalizeOpencodeHistory>["usage"];
}> {
  const events: OpencodeDurableEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await client.history(opencodeSessionId, after, HISTORY_PAGE);
    events.push(...page.events);
    const last = page.events[page.events.length - 1];
    if (last?.durable !== undefined) after = last.durable.seq;
    if (!page.hasMore || page.events.length === 0) break;
  }
  const { items, usage } = normalizeOpencodeHistory(events);
  return usage !== undefined ? { items, initialUsage: usage } : { items };
}

/**
 * Delete the server-side session (cascades its events) and drop local
 * state. Metadata disk deletion is the caller's job.
 */
export async function deleteOpencodeLoop(loop: OpencodeLoop): Promise<void> {
  loop.disposed = true;
  loop.streamAbort?.abort();
  loop.detachLive?.();
  loops.delete(loop.thinkiteSessionId);
  try {
    await loop.client.deleteSession(loop.opencodeSessionId);
  } catch (err) {
    if (err instanceof OpencodeApiError && err.status === 404) return;
    throw err;
  }
}

/** Abort every loop stream. Called from `daemon.stop()` before the host. */
export async function shutdownOpencodeLoops(): Promise<void> {
  const all = [...loops.values()];
  loops.clear();
  for (const loop of all) {
    loop.disposed = true;
    try {
      loop.streamAbort?.abort();
    } catch {
      // Best-effort.
    }
    try {
      loop.detachLive?.();
    } catch {
      // Best-effort.
    }
  }
}

// ─── Activity ────────────────────────────────────────────────────────

function markRunning(runtime: SessionRuntime<EventDelta>): void {
  runtime.setActivity("running");
  try {
    runtime.bridge?.reportState("running");
  } catch {
    // Best-effort mirror — never break the turn on it.
  }
}

function markIdle(runtime: SessionRuntime<EventDelta>): void {
  runtime.setActivity("idle");
  try {
    runtime.bridge?.reportState("idle");
  } catch {
    // Best-effort mirror — never break the turn on it.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
