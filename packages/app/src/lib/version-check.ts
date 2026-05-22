/**
 * Soft-version comparison for the app↔daemon UX-mismatch banner.
 *
 * `daemonVersion` and `appVersion` are semver strings (`"1.2.3"`,
 * `"0.5.0-beta.1"`). We compare ONLY major numbers — patch / minor
 * differences are by convention non-breaking (npm semver `^1.x` /
 * Cargo's caret range), so they shouldn't trigger user-facing UI.
 *
 * Why not pull in `semver`: RN bundle bloat (~150KB) for a single
 * major-equality check is unjustified. The hand-rolled split is
 * deliberately permissive — anything pre the first `.` is the major,
 * non-string / empty input → "unknown major" → treated as a mismatch
 * so we err on the side of warning when we can't tell.
 *
 * Daemon does the same hand-rolled compare today; when we add per-
 * feature MIN_VERSION capability gating (planned pre-launch, see
 * sidecodeapp/sidecode#5), the daemon will pull in the canonical
 * `semver` package for its `satisfies()` semantics. This iOS module
 * stays lightweight regardless.
 */
export function isSameMajor(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ma = parseMajor(a);
  const mb = parseMajor(b);
  if (ma === null || mb === null) return false;
  return ma === mb;
}

function parseMajor(v: string | null | undefined): number | null {
  if (typeof v !== "string" || v.length === 0) return null;
  const head = v.split(".")[0];
  if (!head) return null;
  const n = Number.parseInt(head, 10);
  return Number.isFinite(n) ? n : null;
}
