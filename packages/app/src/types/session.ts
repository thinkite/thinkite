/**
 * Slim session shape the iOS list renders. Mirrors a subset of the daemon's
 * protocol `sessionInfo` plus a few Desktop-mirror fields we know we want to
 * display. We re-declare instead of importing @sidecodeapp/protocol so Metro
 * doesn't have to resolve the workspace package; promote to shared type when
 * the WS client lands and protocol drift becomes a concern.
 */
export interface SessionInfo {
  /** Stable identifier — for Desktop-mirror sessions this is `local_<uuid>`,
   *  for sidecode-created (V0.5+) it's the cliSessionId. */
  sessionId: string;
  /** CLI session UUID. Always present per protocol contract — used to fetch
   *  the message transcript via `getMessages`. */
  cliSessionId: string;
  /** Sidecode-side flag for whether the "Continue on Desktop" button shows. */
  origin: "desktop-mirror" | "sidecode-created";
  /** Human-readable title. Empty string when Anthropic hasn't synthesized one yet. */
  title: string;
  /** Absolute path of where the session is running. May be a worktree if
   *  this is a fork — group by `originCwd` instead. UI may truncate. */
  cwd: string;
  /** Parent project root. Equal to `cwd` for non-fork sessions; differs for
   *  forks (cwd = worktree, originCwd = repo root). The list groups by this. */
  originCwd: string;
  /** Epoch ms. */
  lastActivityAt: number;
  /** Raw model string as persisted on disk — `claude-opus-4-7[1m]` for
   *  Desktop sessions (preserves `[1m]` 1M-context suffix) or SDK alias
   *  (`default` / `sonnet` / `haiku`) for sidecode-created. Use for
   *  equality checks (picker-selected state) or to round-trip back into
   *  sendPrompt. For display, prefer `modelLabel`. */
  model?: string;
  /** Display-formatted version of `model` — e.g. "Opus 4.7 1M" derived
   *  on the daemon. Render this in lists / headers; fall back to `model`
   *  when missing. */
  modelLabel?: string;
  isArchived: boolean;
}
