import { formatModelRef, type ModelInfo } from "@thinkite/oc-client";

// How the model picker lays out the catalog, after the desktop's
// (packages/desktop/src/components/ModelPicker.tsx, which still has its own
// copy): providers in opencode desktop's order, then by name; by default
// only the newest model of each family from the last six months, the
// current one always; a search looks through everything.

/** opencode desktop's provider order; the rest follow by name. */
const POPULAR_PROVIDERS = [
  "opencode-go",
  "opencode",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
];

const SIX_MONTHS = 1000 * 60 * 60 * 24 * 30 * 6;

export const refOf = (m: ModelInfo) => formatModelRef(m.providerID, m.id);

export const isFreeModel = (m: ModelInfo) =>
  m.providerID === "opencode" && (m.cost[0]?.input ?? 0) === 0;

/** opencode marks the latest of a line with "(latest)" in its name. */
export const displayName = (m: ModelInfo) =>
  m.name.replace("(latest)", "").trim();

/** Per provider, the newest model of each family (free and paid twins
 *  apart) released in the last six months. */
export function newestOfFamilies(
  models: readonly ModelInfo[],
  now = Date.now(),
): Set<string> {
  const newest = new Map<string, ModelInfo>();
  for (const m of models) {
    if (Math.abs(now - m.time.released) >= SIX_MONTHS) continue;
    const key = `${m.providerID}:${m.family ?? m.id}:${isFreeModel(m)}`;
    const current = newest.get(key);
    if (current === undefined || m.time.released > current.time.released)
      newest.set(key, m);
  }
  return new Set([...newest.values()].map(refOf));
}

/** Search text without case, spaces or apostrophes: a pinyin keyboard
 *  reports Latin letters it is still composing split into syllables
 *  ("o'pu's", "o pu s"), and model names space their words freely. */
const searchKey = (s: string) => s.toLowerCase().replace(/[\s']/g, "");

function providerRank(id: string): number {
  const index = POPULAR_PROVIDERS.indexOf(id);
  return index < 0 ? POPULAR_PROVIDERS.length : index;
}

export interface ModelSection {
  providerID: string;
  title: string;
  models: ModelInfo[];
}

/**
 * The picker's sections. With an empty `query`, the newest of each family
 * plus `current` (and models with no release date); otherwise every model
 * whose name or provider contains the query.
 */
export function modelSections(
  models: readonly ModelInfo[],
  providers: ReadonlyMap<string, string>,
  current: string | null,
  query: string,
  now = Date.now(),
): ModelSection[] {
  const q = searchKey(query);
  const latest = q === "" ? newestOfFamilies(models, now) : null;
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of models) {
    const provider = providers.get(m.providerID) ?? m.providerID;
    const shown =
      latest === null
        ? searchKey(displayName(m)).includes(q) ||
          searchKey(provider).includes(q)
        : refOf(m) === current ||
          latest.has(refOf(m)) ||
          !Number.isFinite(m.time.released) ||
          m.time.released === 0;
    if (!shown) continue;
    const group = byProvider.get(m.providerID) ?? [];
    group.push(m);
    byProvider.set(m.providerID, group);
  }
  const title = (id: string) => providers.get(id) ?? id;
  return [...byProvider]
    .sort(
      ([a], [b]) =>
        providerRank(a) - providerRank(b) || title(a).localeCompare(title(b)),
    )
    .map(([providerID, group]) => ({
      providerID,
      title: title(providerID),
      models: group.sort((a, b) =>
        displayName(a).localeCompare(displayName(b)),
      ),
    }));
}
