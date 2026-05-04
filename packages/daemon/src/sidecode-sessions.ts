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

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
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
   * Display title — empty initially, SDK / Desktop fill in via auto-summary
   * once the session has enough content. iOS shows "Untitled" fallback when
   * empty (same as Desktop-mirrored sessions).
   */
  title: string;
  titleSource: "auto";
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
 * Build a fresh metadata record for a session sidecode is creating now.
 * `now` defaults to `Date.now()` but is injectable for deterministic
 * tests. `cliSessionId` is the UUID iOS supplied (= what we pass to
 * SDK's `options.sessionId`).
 */
export function buildNewSidecodeSession(input: {
  cliSessionId: string;
  cwd: string;
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
    title: "",
    titleSource: "auto",
    // V0 uses bypassPermissions — no in-app permission prompts yet (see
    // project_session_replay_model memory: permission_requested /
    // permission_resolved frames deferred to V0.5+).
    permissionMode: "bypassPermissions",
  };
}
