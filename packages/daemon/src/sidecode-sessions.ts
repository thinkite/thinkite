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
  /** Cumulative turn count; V0 starts at 0 and doesn't yet bump on each turn. */
  completedTurns: number;
  /**
   * Display title — empty initially. Filled in lazily by `listSessions`'s
   * fetch-and-write-back pass: it reads SDK's `getSessionInfo().summary`
   * and persists it here, so subsequent reads (and iOS display) come
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
 * `opts.cwd` filters by exact-match cwd (same semantics as
 * `listDesktopSessions`); omit to return all sessions across all cwds.
 *
 * Order is unspecified — the router unions with Desktop sessions and
 * sorts by `lastActivityAt` once.
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
      parsed = JSON.parse(readFileSync(path, "utf8")) as SidecodeSessionMetadata;
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
 * Atomically merge a new `title` into a sidecode session metadata file.
 *
 * Honors the `"user"` titleSource lock: if the on-disk record already has
 * `titleSource === "user"` (set by `/rename`), this is a no-op — user
 * intent always wins over auto-fetched SDK summaries. Otherwise writes
 * `{ ...existing, title, titleSource: "auto" }` via the same atomic
 * tmp+rename as `writeSidecodeSession`.
 *
 * Returns the title that ended up on disk (the new one, or the existing
 * user-set one if locked, or empty when the metadata file is missing).
 *
 * V0 race note: there is no rename UI yet, so the read-then-write
 * sequence here can't be raced by `/rename`. When V0.5+ adds rename,
 * this function still re-reads inside, so a `/rename` write that lands
 * between `readSidecodeSession` and `writeSidecodeSession` will be
 * preserved on the second read here as long as it set `titleSource:
 * "user"` first.
 */
export function updateSidecodeSessionTitle(
  home: string,
  cliSessionId: string,
  title: string,
): string {
  const existing = readSidecodeSession(home, cliSessionId);
  if (!existing) return "";
  if (existing.titleSource === "user") return existing.title;
  const updated: SidecodeSessionMetadata = {
    ...existing,
    title,
    titleSource: "auto",
  };
  writeSidecodeSession(home, updated);
  return title;
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
    completedTurns: 0,
    title: deriveTitleFromFirstPrompt(input.firstPrompt),
    titleSource: "auto",
    // V0 uses bypassPermissions — no in-app permission prompts yet (see
    // project_session_replay_model memory: permission_requested /
    // permission_resolved frames deferred to V0.5+).
    permissionMode: "bypassPermissions",
  };
}
