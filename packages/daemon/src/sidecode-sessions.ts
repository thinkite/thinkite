/**
 * Persistence for sidecode-created sessions: one JSON file per session at
 * `<home>/sessions/local_<sessionId>.json`. Mirrors Desktop's
 * `claude-code-sessions/<...>/local_*.json` schema (field names verbatim)
 * so the data is forward-compatible with a future "promote sidecode
 * session into Desktop" feature — see project_sidecode_persistence
 * memory for the full rationale.
 *
 * V0 G3 only writes; reads happen via the existing Desktop session
 * discovery path (which scans Desktop's directory; sidecode metadata
 * will be union'd in by V0.5+ when iOS-list shows sidecode entries).
 *
 * Filename prefix `local_<id>.json` reserves space for future origin
 * types (`cloud_*.json` / `remote_*.json`) without re-keying the dir.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/**
 * Persisted shape for a sidecode-created session. Field names are an
 * intentional subset of Desktop's `local_*.json` so a `cp` from
 * `<home>/sessions/` to `<desktop-claude-code-sessions>/<env>/<env>/`
 * imports cleanly. V0 fills the small set needed by Desktop's
 * conservative-read fallback; later slices may add `effort`, `model`,
 * `permissionMode`, etc. as those features land.
 */
export interface SidecodeSessionMetadata {
  /** `local_<cliSessionId>` — Desktop convention. */
  sessionId: string;
  /** The Anthropic-side session UUID (= the JSONL filename in `~/.claude/projects/`). */
  cliSessionId: string;
  cwd: string;
  /** No fork support in V0 — same as cwd. */
  originCwd: string;
  /** Epoch ms when sidecode created this metadata. */
  createdAt: number;
  /** Epoch ms; updated on each turn (V0 just sets equal to createdAt at write). */
  lastActivityAt: number;
  isArchived: boolean;
  /**
   * Display title — derived from the user's first prompt at session
   * creation (`buildNewSidecodeSession` → `deriveTitleFromFirstPrompt`)
   * and persisted here, so subsequent reads (and iOS display) come
   * straight from this file. Sidecode metadata is the truth source for
   * the app — display never falls back to `getSessionInfo` at render
   * time.
   */
  title: string;
  /**
   * Provenance of `title`. `"auto"` means "filled by daemon from SDK
   * summary"; daemon may overwrite freely. `"user"` means "set explicitly
   * via `/rename`" (V0.5+); daemon must NOT overwrite — `/rename` writes
   * only sidecode metadata, never the SDK's `renameSession`, so this
   * field is the only authority on user intent.
   */
  titleSource: "auto" | "user";
  permissionMode: "bypassPermissions" | "default";
  /** Last model the user picked for this session, raw SDK key (e.g.
   *  `claude-opus-4-8`). Optional because pre-feature sidecode session files
   *  on disk won't have it; daemon treats absent as "unknown, use SDK
   *  default on next sendPrompt". */
  model?: string;
  /** Schema placeholder for Desktop compatibility. Desktop's
   *  `local_*.json` always carries an `effort` field; sidecode V0
   *  doesn't expose effort in the picker (see input-bar.tsx) but still
   *  writes the field so a sidecode-created file is forward-compatible
   *  with a future "promote to Desktop" flow (or a manual `cp`).
   *  Hardcoded to `"xhigh"` — the value isn't read by sidecode at any
   *  point. Desktop's behavior with `effort` ≠ supportedEffortLevels
   *  is their own concern (they don't cross-validate either). */
  effort: "xhigh";
  /** CCR bridge worker state — present iff this session is currently
   *  bridged to a cloud cse_ session. Drives M3.4 startup re-attach:
   *  daemon boot → scan sessions → any with `bridge` present → re-attach
   *  with `initialSequenceNum = bridge.lastSSESequenceNum` → server
   *  replays seq > N (EXCLUSIVE — no double-execute). See
   *  project_sidecode_ccr_architecture "Restart re-attach" for the
   *  semantic proof from spike ccr-reattach. */
  bridge?: BridgeWorkerState;
}

/**
 * Mirror of the SDK's per-worker checkpoint state, persisted alongside
 * sidecode session metadata so M3.4 startup re-attach has everything
 * it needs without round-tripping the cloud.
 *
 * Why on `SidecodeSessionMetadata` (one JSON file per session) and not a
 * separate `bridges/` dir: the lifecycle is per-session anyway (one bridge
 * per local session), and atomic tmp+rename already gives us crash safety.
 * Avoids a second persistence path.
 *
 * The `claudeSessionId` (local SDK session uuid) IS the parent
 * `cliSessionId` — no need to duplicate it inside this nested object.
 */
export interface BridgeWorkerState {
  /** `cse_*` cloud session id from `createCodeSession`. Stable for the
   *  lifetime of the bridged session — every re-attach reuses it
   *  (`fetchRemoteCredentials(cse)` bumps epoch but the id stays). */
  cseSessionId: string;
  /** High-water mark of the SSE sequence number we've FULLY PROCESSED.
   *  Checkpointed after each turn completes (in forwardToBridge's result
   *  branch, via `runtime.bridge.checkpoint()`). On re-attach we pass
   *  this to `attachBridgeSession({initialSequenceNum})` and the server
   *  replays only seq > this value (EXCLUSIVE), giving at-least-once
   *  delivery across daemon crashes.
   *
   *  V0 single-in-flight assumption: we don't track per-prompt seq; we
   *  just snapshot `handle.getSequenceNum()` at each turn-complete.
   *  Multi-prompt back-pressure (prompt #2 arrives while prompt #1 is
   *  processing) would mis-checkpoint past #2 → on crash, #2 is lost.
   *  Acceptable at V0 scale (typical UX is type-wait-type); revisit if
   *  power users hit it. */
  lastSSESequenceNum: number;
  /** Has the historical-message backfill been done for this bridge?
   *  Set to false at create-bridged (no history to flush); set to true
   *  by M3.3 upgrade (after `getSessionMessages → write(historical) →
   *  flush`). Re-attach checks this — only fresh upgrade needs backfill;
   *  re-attach of an already-backfilled bridge skips it. */
  backfilled: boolean;
}

/**
 * Build the path `<home>/sessions/local_<cliSessionId>.json`. Pure —
 * doesn't create the directory, doesn't check existence.
 */
export function sidecodeSessionPath(
  home: string,
  cliSessionId: string,
): string {
  return join(home, "sessions", `local_${cliSessionId}.json`);
}

/**
 * Atomically write a sidecode session metadata file: write to `.tmp` +
 * rename. Creates `<home>/sessions/` on first call. 0600 perms (same as
 * `known_clients.json`).
 *
 * Idempotent: re-writing overwrites. Caller is responsible for choosing
 * when to overwrite vs skip (V0 G3 writes once on session create).
 */
export function writeSidecodeSession(
  home: string,
  metadata: SidecodeSessionMetadata,
): void {
  const dir = join(home, "sessions");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const target = sidecodeSessionPath(home, metadata.cliSessionId);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(tmp, target);
}

/**
 * Read a single sidecode session metadata file. Returns `undefined` when
 * the file is missing (cliSessionId never created by sidecode, or removed)
 * or malformed (corrupt JSON, schema mismatch — caller can't act on it
 * either way). Synchronous to match the rest of this module.
 */
export function readSidecodeSession(
  home: string,
  cliSessionId: string,
): SidecodeSessionMetadata | undefined {
  const path = sidecodeSessionPath(home, cliSessionId);
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as SidecodeSessionMetadata;
    if (!parsed?.cliSessionId) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * List every sidecode-created session under `<home>/sessions/`.
 *
 * Filename convention is `local_<cliSessionId>.json`; anything else is
 * skipped. Malformed JSON files are skipped silently — a single corrupt
 * file must not break the whole listing (matches Desktop's behavior).
 *
 * `opts.cwd` filters by exact-match cwd; omit to return all sessions
 * across all cwds.
 *
 * Order is unspecified — consumers (subscribeSessions fan-out,
 * getFilesystemRoots recent-cwds) sort by `lastActivityAt` themselves.
 */
export function listSidecodeSessions(
  home: string,
  opts: { cwd?: string } = {},
): SidecodeSessionMetadata[] {
  const dir = join(home, "sessions");
  if (!existsSync(dir)) return [];

  const out: SidecodeSessionMetadata[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  for (const name of entries) {
    if (!name.startsWith("local_") || !name.endsWith(".json")) continue;
    if (name.endsWith(".tmp")) continue; // mid-rename atomic-write artifact
    const path = join(dir, name);
    let parsed: SidecodeSessionMetadata;
    try {
      parsed = JSON.parse(
        readFileSync(path, "utf8"),
      ) as SidecodeSessionMetadata;
    } catch {
      continue;
    }
    if (!parsed?.cliSessionId) continue;
    if (opts.cwd !== undefined && parsed.cwd !== opts.cwd) continue;
    out.push(parsed);
  }
  return out;
}

/**
 * Maximum stored title length. The full prompt text can be paragraph-sized
 * (an actual `Edit this file: ...\n\n<long context>`) but the title surface
 * on the iOS row is one line — clipping at write time prevents pathological
 * metadata bloat without changing the rendered look.
 */
const TITLE_MAX_LEN = 200;

/**
 * Derive the auto-title for a freshly-created sidecode session from the
 * user's first prompt. Strips newlines (collapses to single line) and
 * caps at TITLE_MAX_LEN — typical chat prompts fit; multi-paragraph
 * pastes get truncated with an ellipsis.
 */
function deriveTitleFromFirstPrompt(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= TITLE_MAX_LEN) return oneLine;
  return `${oneLine.slice(0, TITLE_MAX_LEN - 1).trimEnd()}…`;
}

/**
 * Build a fresh metadata record for a session sidecode is creating now.
 *
 * `firstPrompt` is the user's opening message — we snapshot it as
 * `title` immediately (titleSource: "auto") so the iOS sidebar has a
 * meaningful label as soon as the session exists. We deliberately do
 * NOT later refresh from SDK `getSessionInfo().summary`: empirically
 * (checked against ~7 of the user's own Desktop sessions on
 * 2026-05-08), the SDK never writes `aiTitle` for either CLI or SDK-
 * driven sessions, so its `summary` falls through to `lastPrompt` —
 * which would mean our stored title rotates through every new user
 * message the SDK appends. Freezing on firstPrompt matches the
 * Claude iOS / ChatGPT title behavior that users expect.
 *
 * `/rename` (V0.5+) will set `titleSource: "user"` and overwrite
 * `title` with whatever the user typed; `updateSidecodeSessionTitle`
 * already enforces that lock.
 *
 * TODO(post-V0): an LLM-driven topic-summarizer pass after N turns
 * would give a real "Discussion about X" style title. Cheap option:
 * one Haiku call on `turn_completed` with the first ~500 tokens of
 * the conversation, written to `metadata.title` only when
 * `titleSource === "auto"`. Not in V0 scope.
 *
 * `now` defaults to `Date.now()` but is injectable for deterministic
 * tests. `cliSessionId` is the UUID iOS supplied (= what we pass to
 * SDK's `options.sessionId`).
 */
export function buildNewSidecodeSession(input: {
  cliSessionId: string;
  cwd: string;
  firstPrompt: string;
  /** Picker model committed alongside this prompt. Persisted as the
   *  session's `model` (Desktop-schema-aligned). Undefined when the iOS
   *  picker hasn't bootstrapped yet — daemon records what it gets, and
   *  resume-time `setSessionSelection` fills the gap on next pick. */
  model?: string;
  now?: number;
}): SidecodeSessionMetadata {
  const now = input.now ?? Date.now();
  return {
    sessionId: `local_${input.cliSessionId}`,
    cliSessionId: input.cliSessionId,
    cwd: input.cwd,
    originCwd: input.cwd,
    createdAt: now,
    lastActivityAt: now,
    isArchived: false,
    title: deriveTitleFromFirstPrompt(input.firstPrompt),
    titleSource: "auto",
    // V0 uses bypassPermissions — no in-app permission prompts yet (see
    // project_session_replay_model memory: permission_requested /
    // permission_resolved frames deferred to V0.5+).
    permissionMode: "bypassPermissions",
    // Hardcoded schema placeholder — see SidecodeSessionMetadata.effort.
    effort: "xhigh",
    ...(input.model !== undefined ? { model: input.model } : {}),
  };
}

/**
 * Atomically attach (or replace) a session's bridge worker state.
 *
 * Called by `BridgeService.attach` after `BridgeTransport.attach` returns
 * a connected handle — at that point the cse_ id is known and we record
 * the mapping (cliSessionId ↔ cseSessionId) so daemon-restart-time
 * re-attach (M3.4) can find every bridged session by scanning sidecode
 * metadata, NOT by querying the cloud.
 *
 * Caller is responsible for ensuring the metadata file already exists
 * (sidecode V0 always creates the metadata when the session is created;
 * upgrade flow M3.3 will hit pre-existing metadata too). Returns the
 * merged metadata, or `undefined` if the metadata file wasn't there —
 * the bridge would be live without a persisted record, callers should
 * treat this as a bug rather than retry.
 */
export function writeBridgeWorkerState(
  home: string,
  cliSessionId: string,
  state: BridgeWorkerState,
): SidecodeSessionMetadata | undefined {
  const existing = readSidecodeSession(home, cliSessionId);
  if (!existing) return undefined;
  const merged: SidecodeSessionMetadata = { ...existing, bridge: { ...state } };
  writeSidecodeSession(home, merged);
  return merged;
}

/**
 * Atomically advance the SSE sequence-number high-water mark for a
 * session's bridge worker state. Called at every turn-complete from
 * `forwardToBridge`'s result branch (via `runtime.bridge.checkpoint()`).
 *
 * No-op (returns `undefined`) when the metadata file is missing or
 * `bridge` is absent — pure (non-bridged) sessions trigger no-op via
 * `runtime.bridge?.checkpoint()` upstream and shouldn't reach here, but
 * we guard defensively so a torn-down bridge that races a final turn
 * doesn't fault.
 *
 * Hot-path concern (V0 single-digit sessions, low rate): atomic
 * tmp+rename is cheap (~ms) and we only fire on result envelopes (one
 * per turn), not per stream-event delta. If this ever shows up in flame
 * graphs, batch via debounced write — keep eager for now.
 */
export function updateBridgeSequenceNum(
  home: string,
  cliSessionId: string,
  lastSSESequenceNum: number,
): SidecodeSessionMetadata | undefined {
  const existing = readSidecodeSession(home, cliSessionId);
  if (!existing?.bridge) return undefined;
  // Never let the checkpoint move BACKWARDS (a stale callback firing
  // after detach could regress us). The SDK's SSE counter is monotonic,
  // so any non-monotonic write is by definition a bug worth dropping.
  if (lastSSESequenceNum <= existing.bridge.lastSSESequenceNum) return existing;
  const merged: SidecodeSessionMetadata = {
    ...existing,
    bridge: { ...existing.bridge, lastSSESequenceNum },
  };
  writeSidecodeSession(home, merged);
  return merged;
}

/**
 * Atomically mark a session's bridge as backfilled. Called by M3.3
 * upgrade flow after `getSessionMessages → write(historical) → flush`
 * completes. No-op when the metadata file is missing or `bridge` is
 * absent. Idempotent.
 */
export function markBridgeBackfilled(
  home: string,
  cliSessionId: string,
): SidecodeSessionMetadata | undefined {
  const existing = readSidecodeSession(home, cliSessionId);
  if (!existing?.bridge) return undefined;
  if (existing.bridge.backfilled) return existing;
  const merged: SidecodeSessionMetadata = {
    ...existing,
    bridge: { ...existing.bridge, backfilled: true },
  };
  writeSidecodeSession(home, merged);
  return merged;
}

/**
 * Atomically remove the `bridge` field from a session's metadata. Called
 * by `BridgeService.detach` on clean tear-down so M3.4 startup re-attach
 * doesn't try to re-attach sessions the user explicitly unbridged.
 *
 * Does NOT touch the rest of the metadata — the session itself remains
 * (pure-session continuation is fine; the cloud transcript persists
 * server-side regardless). No-op when missing or already-absent.
 */
export function clearBridgeWorkerState(
  home: string,
  cliSessionId: string,
): SidecodeSessionMetadata | undefined {
  const existing = readSidecodeSession(home, cliSessionId);
  if (!existing?.bridge) return existing;
  const { bridge: _, ...rest } = existing;
  writeSidecodeSession(home, rest);
  return rest;
}
