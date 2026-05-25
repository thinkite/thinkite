/**
 * Hardcoded per-model display + capability metadata. Single source of truth
 * for "what model strings does sidecode know about, and how should they
 * render in the iOS UI". Loaded by [router.ts] for the `prettyModel`
 * conversion (DesktopSession.model → SessionInfo.modelLabel) and by the
 * `getModels` RPC for the picker.
 *
 * Why hardcoded instead of fetched from SDK at runtime:
 *   - SDK's `query.supportedModels()` requires spawning a Claude
 *     subprocess (heavy) and only returns three aliases (`default` /
 *     `sonnet` / `haiku`) — not the canonical-with-suffix names that
 *     Desktop session metadata persists (e.g. `claude-opus-4-7[1m]`).
 *   - We need to display old/deprecated models that appear in user's
 *     historical session files even after Anthropic stops listing them.
 *   - Anthropic ships new Claude models roughly quarterly — a sidecode
 *     release-per-launch cadence is acceptable for this list.
 *
 * Update policy on Claude model launches — search `@[MODEL LAUNCH]`:
 *   1. Add a new entry for the new canonical ID (and `[1m]` variant if any)
 *   2. Move the previous-generation entry's `isDefault` to the new one
 *   3. Mark the displaced previous-generation entry as `deprecated: true`
 *      (DON'T delete — historical sessions still reference it on disk)
 *
 * Effort levels deliberately NOT modeled here. sidecode V0 trusts the
 * SDK's adaptive thinking + per-account `Settings.effortLevel` default;
 * we don't expose a per-session effort picker. Power users tweak via
 * Desktop `/effort` slash command which persists to settings.json; we
 * honor that implicitly by not passing `--effort` on our subprocess.
 */

/** Per-model metadata. All fields except `displayName` are optional —
 *  consumers that need richer info (picker UI, usage meter) add fields
 *  as use cases land. */
export type ModelMetadata = {
  /** Required. UI-facing label — session list rows, detail header,
   *  picker entries. e.g. `"Opus 4.7 1M"`. */
  displayName: string;

  /** Exactly ONE entry in `MODEL_METADATA` should set this `true`. Marks
   *  the model used when iOS hasn't picked anything explicitly (new-
   *  session bootstrap). The startup self-check at the bottom of this
   *  file throws if zero or multiple defaults are set. */
  isDefault?: boolean;

  /** Picker subtitle (V0.5+). Empty / omitted is fine — picker can fall
   *  back to `displayName` alone. */
  description?: string;

  /** When `true`, the picker filters this entry out of the new-session
   *  list. The entry is KEPT in this table though — historical Desktop
   *  sessions persisted with this model still need to render their label
   *  in the session list / detail header. */
  deprecated?: boolean;

  /** Context window in tokens (V1 usage meter). Optional because the
   *  meter can derive 1M vs 200K from the `[1m]` suffix of the key when
   *  this is absent. Set explicitly when needed. */
  contextWindow?: number;
};

/**
 * @[MODEL LAUNCH] update this table when Anthropic ships a new Claude.
 *
 * Keys are the raw strings as they appear in Desktop session metadata
 * (`local_*.json` `model` field) and as CLI `--model` flag accepts them.
 * Includes both standard and `[1m]` 1M-context variants as separate
 * entries since they render with different labels.
 */
export const MODEL_METADATA: Record<string, ModelMetadata> = {
  // ─── Current models ─────────────────────────────────────────────────
  "claude-opus-4-7[1m]": {
    displayName: "Opus 4.7 1M",
    isDefault: true,
  },
  "claude-opus-4-7": {
    displayName: "Opus 4.7",
  },
  "claude-sonnet-4-6[1m]": {
    displayName: "Sonnet 4.6 1M",
  },
  "claude-sonnet-4-6": {
    displayName: "Sonnet 4.6",
  },
  "claude-haiku-4-5-20251001": {
    displayName: "Haiku 4.5",
  },

  // ─── Deprecated (still present in historical Desktop session files) ─
  "claude-opus-4-6[1m]": {
    displayName: "Opus 4.6 1M",
    deprecated: true,
  },
  "claude-opus-4-6": {
    displayName: "Opus 4.6",
    deprecated: true,
  },
  "claude-sonnet-4-5-20250929": {
    displayName: "Sonnet 4.5",
    deprecated: true,
  },
  "claude-opus-4-5-20251101": {
    displayName: "Opus 4.5",
    deprecated: true,
  },
  "claude-opus-4-1-20250805": {
    displayName: "Opus 4.1",
    deprecated: true,
  },
  "claude-sonnet-4-20250514": {
    displayName: "Sonnet 4",
    deprecated: true,
  },
  "claude-opus-4-20250514": {
    displayName: "Opus 4",
    deprecated: true,
  },
};

/**
 * Convert a raw model string (from Desktop metadata or SDK options) into
 * the human-readable label for UI. Unknown models fall through to the raw
 * string — at least the user sees something informative (e.g. a brand-new
 * Anthropic release that sidecode hasn't been updated for).
 */
export function prettyModel(raw: string): string {
  if (!raw) return "";
  return MODEL_METADATA[raw]?.displayName ?? raw;
}

/**
 * Return the default model's raw key. Throws (via the module-load
 * assertion below) if MODEL_METADATA is misconfigured — so any caller is
 * guaranteed a valid result at runtime.
 */
export function getDefaultModel(): string {
  const entry = Object.entries(MODEL_METADATA).find(
    ([, meta]) => meta.isDefault === true,
  );
  if (!entry) {
    // Unreachable: the module-load self-check below would have thrown.
    throw new Error("MODEL_METADATA has no isDefault entry");
  }
  return entry[0];
}

// ─── Module-load self-check ──────────────────────────────────────────
// Runs once at import. Fails fast if the table is misconfigured so
// daemon startup crashes loudly rather than silently misbehaving.
(() => {
  const defaults = Object.entries(MODEL_METADATA).filter(
    ([, m]) => m.isDefault === true,
  );
  if (defaults.length !== 1) {
    throw new Error(
      `MODEL_METADATA must have exactly one entry with isDefault=true, ` +
        `found ${defaults.length}: ${defaults.map(([k]) => k).join(", ") || "none"}`,
    );
  }
  const [defaultKey, defaultMeta] = defaults[0];
  if (defaultMeta.deprecated) {
    throw new Error(
      `MODEL_METADATA entry "${defaultKey}" can't be both isDefault and deprecated`,
    );
  }
})();
