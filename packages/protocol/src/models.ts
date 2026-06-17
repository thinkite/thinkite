/**
 * Hardcoded per-model display + capability metadata. Single source of truth
 * for "what model strings does sidecode know about, and how should they
 * render in the iOS UI".
 *
 * Lives in the protocol package because both sides use it directly —
 * iOS bundles `MODELS` / `DEFAULT_MODEL` for the picker (no async RPC,
 * no loading state), and daemon imports `prettyModel` / `MODEL_METADATA`
 * for label rendering + the runtime default lookup.
 *
 * Why hardcoded instead of fetched from SDK at runtime:
 *   - SDK's `query.supportedModels()` requires spawning a Claude
 *     subprocess (heavy) and only returns three aliases (`default` /
 *     `sonnet` / `haiku`) — not the canonical names session metadata
 *     persists (e.g. `claude-opus-4-8`).
 *   - We need to render old/deprecated models that appear in a user's
 *     historical sidecode session files even after Anthropic stops
 *     listing them.
 *   - Anthropic ships new Claude models roughly quarterly — a sidecode
 *     release-per-launch cadence is acceptable for this list.
 *
 * Why protocol-bundled instead of daemon-owned-via-RPC (history):
 *   The first design had daemon serve a `getModels` RPC so iOS didn't
 *   ship its own copy. That decoupling was overkill — daemon + iOS ship
 *   together in this monorepo on the same release cadence, so the table
 *   is effectively atomic either way. Moving it here:
 *     - Eliminates one cold-start RPC roundtrip.
 *     - Eliminates `useModels()` loading state — the picker is fully
 *       populated at first render, and `useState` can seed selection
 *       to `DEFAULT_MODEL` via an init function (no bootstrap useEffect
 *       reading null on first mount).
 *
 * On the `[1m]` suffix (legacy): the 1M context window used to be an
 * opt-in beta you requested with a `claude-…[1m]` suffix. Current-gen
 * models (Opus 4.6/4.7/4.8, Sonnet 4.6, Fable 5) are natively 1M on the
 * Claude API with NO suffix, and the bundled CLI auto-strips `[1m]` for
 * them (CLI ≥ 2.1.173). So this table carries bare ids only; `prettyModel`
 * normalizes any residual `…[1m]` id (from a pre-change session file) by
 * stripping the suffix before lookup. See memory `project_opus_1m_default`.
 *
 * Sonnet 1M is deliberately NOT supported: its 1M variant is gated behind
 * "extra usage" overage billing (off by default), so the picker offers the
 * 200K `claude-sonnet-4-6` only — no `[1m]` Sonnet entry, ever.
 *
 * Update policy on Claude model launches — search `@[MODEL LAUNCH]`:
 *   1. Add ONE new entry for the new canonical id. Current-gen Opus is
 *      natively 1M, so it's a bare id with `contextWindow: 1_000_000` —
 *      no `[1m]` variant.
 *   2. Move the previous-generation entry's `isDefault` to the new one.
 *   3. Mark the displaced previous-generation entry `deprecated: true`
 *      (DON'T delete — historical *sidecode* sessions still reference it
 *      on disk, and `prettyModel` renders their label from this table).
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
export interface ModelMetadata {
  /** Required. UI-facing label — session list rows, detail header,
   *  picker entries. e.g. `"Opus 4.8"`. */
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
   *  list. The entry is KEPT in this table though — historical sidecode
   *  sessions persisted with this model still need to render their label
   *  in the session list / detail header. */
  deprecated?: boolean;

  /** Context window in tokens. Powers iOS's context meter on the model
   *  picker chip (fill % of chip background = used / contextWindow).
   *  Formula mirrors Claude Code's `/context` command:
   *  `used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`
   *  (output tokens excluded). Filled for ALL entries — even deprecated
   *  ones — so a resume of a deprecated-model session that we ever
   *  surface in the future has the data ready. `MODELS` filters
   *  deprecated out so iOS only sees current entries.
   *
   *  Anthropic context window reference (verify before adding new
   *  entries): https://docs.claude.com/en/docs/about-claude/models.
   *  Current-gen Opus (4.6+) and Sonnet 4.6 are 1M by default; older
   *  models are 200_000. */
  contextWindow?: number;
}

/**
 * @[MODEL LAUNCH] update this table when Anthropic ships a new Claude.
 *
 * Keys are the raw strings as they appear in session metadata (`model`
 * field) and as the CLI `--model` flag accepts them. Bare ids only —
 * `[1m]` is a legacy opt-in suffix current-gen models don't need (see
 * the header comment).
 */
export const MODEL_METADATA: Record<string, ModelMetadata> = {
  // ─── Current models ─────────────────────────────────────────────────
  "claude-opus-4-8": {
    displayName: "Opus 4.8",
    isDefault: true,
    contextWindow: 1_000_000,
  },
  // Sonnet 4.6 1M omitted: gated behind extra-usage billing (off by
  // default), so the picker offers the 200K variant only.
  "claude-sonnet-4-6": {
    displayName: "Sonnet 4.6",
    contextWindow: 200_000,
  },
  "claude-haiku-4-5-20251001": {
    displayName: "Haiku 4.5",
    contextWindow: 200_000,
  },

  // ─── Deprecated (still present in historical sidecode session files) ─
  "claude-opus-4-7": {
    displayName: "Opus 4.7",
    deprecated: true,
    contextWindow: 1_000_000,
  },
  "claude-opus-4-6": {
    displayName: "Opus 4.6",
    deprecated: true,
    contextWindow: 1_000_000,
  },
  "claude-sonnet-4-5-20250929": {
    displayName: "Sonnet 4.5",
    deprecated: true,
    contextWindow: 200_000,
  },
  "claude-opus-4-5-20251101": {
    displayName: "Opus 4.5",
    deprecated: true,
    contextWindow: 200_000,
  },
  "claude-opus-4-1-20250805": {
    displayName: "Opus 4.1",
    deprecated: true,
    contextWindow: 200_000,
  },
  "claude-sonnet-4-20250514": {
    displayName: "Sonnet 4",
    deprecated: true,
    contextWindow: 200_000,
  },
  "claude-opus-4-20250514": {
    displayName: "Opus 4",
    deprecated: true,
    contextWindow: 200_000,
  },
};

/** Picker-facing model entry. Wire-equivalent shape from when this
 *  table travelled over the `getModels` RPC; kept as the row shape for
 *  the iOS picker / list-row label lookup so call sites don't churn
 *  during the protocol-bundled migration. */
export interface ModelEntry {
  /** Raw key as it appears in session metadata + CLI `--model` flag,
   *  e.g. `"claude-opus-4-8"`. */
  model: string;
  /** Human-readable label, e.g. `"Opus 4.8"`. */
  displayName: string;
  /** Exactly one entry in `MODELS` has this `true`. Picker uses it for
   *  new-session bootstrap when SessionState.model is null. */
  isDefault: boolean;
  /** Optional picker subtitle. */
  description?: string;
  /** Context window in tokens. */
  contextWindow?: number;
}

/**
 * Picker-visible models. Filters `MODEL_METADATA` to non-deprecated
 * entries, preserving source-declaration order (current models first).
 * The module-load self-check below guarantees `DEFAULT_MODEL` is
 * present, so this list is always non-empty.
 */
export const MODELS: readonly ModelEntry[] = Object.entries(MODEL_METADATA)
  .filter(([, m]) => !m.deprecated)
  .map(
    ([model, m]): ModelEntry => ({
      model,
      displayName: m.displayName,
      isDefault: m.isDefault === true,
      description: m.description,
      contextWindow: m.contextWindow,
    }),
  );

/**
 * The current default model — used to seed the new-session picker
 * selection and as the daemon's runtime default. Always non-null
 * (module-load self-check enforces exactly one isDefault entry).
 */
export const DEFAULT_MODEL: ModelEntry = (() => {
  const def = MODELS.find((m) => m.isDefault);
  if (!def) {
    // Unreachable: the module-load self-check below would have thrown.
    throw new Error("MODEL_METADATA has no isDefault entry");
  }
  return def;
})();

/**
 * Convert a raw model string (from session metadata or SDK options) into
 * the human-readable label for UI. Unknown models fall through to the raw
 * string — at least the user sees something informative (e.g. a brand-new
 * Anthropic release that sidecode hasn't been updated for).
 *
 * Normalizes the legacy `[1m]` suffix: an id like `claude-opus-4-8[1m]`
 * persisted by an older sidecode build resolves to its bare entry's label
 * (mirrors the CLI's own auto-strip), so historical sessions don't
 * regress to a raw-string label after the table dropped `[1m]` variants.
 */
export function prettyModel(raw: string): string {
  if (!raw) return "";
  const direct = MODEL_METADATA[raw]?.displayName;
  if (direct) return direct;
  if (raw.endsWith("[1m]")) {
    const bare = MODEL_METADATA[raw.slice(0, -"[1m]".length)]?.displayName;
    if (bare) return bare;
  }
  return raw;
}

/**
 * Return the default model's raw key. Convenience wrapper around
 * `DEFAULT_MODEL.model` — kept as a function for backwards compatibility
 * with the older daemon-only `getDefaultModel()` helper signature.
 */
export function getDefaultModelId(): string {
  return DEFAULT_MODEL.model;
}

// ─── Module-load self-check ──────────────────────────────────────────
// Runs once at import. Fails fast if the table is misconfigured so
// daemon startup (and iOS first render) crashes loudly rather than
// silently misbehaving.
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
