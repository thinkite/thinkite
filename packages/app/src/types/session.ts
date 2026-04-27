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
  /** Sidecode-side flag for whether the "Continue on Desktop" button shows. */
  origin: "desktop-mirror" | "sidecode-created";
  /** Human-readable title. Empty string when Anthropic hasn't synthesized one yet. */
  title: string;
  /** Absolute path; UI may truncate. */
  cwd: string;
  /** Epoch ms. */
  lastActivityAt: number;
  /** Compact model display (e.g. "Opus 4.7"). */
  model: string;
  /** Number of completed assistant turns; absent when unknown. */
  completedTurns?: number;
  isArchived: boolean;
}
