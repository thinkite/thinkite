import { Badge } from "@astryxdesign/core/Badge";
import {
  Selector,
  type SelectorOptionData,
  type SelectorSection,
} from "@astryxdesign/core/Selector";
import { useSelector } from "@tanstack/react-store";
import { formatModelRef, type ModelInfo } from "@thinkite/oc-client";
import { useEffect, useRef, useState } from "react";
import { ocClient } from "../lib/oc";
import { type Prefs, prefs } from "../lib/prefs";

// The composer's model picker, after opencode desktop's
// (`packages/app/src/providers/models/` at v2.1.2, MIT): a searchable list
// of the models the user's providers offer, grouped by provider with the
// popular providers first, a Free tag on opencode's free models and a
// Latest tag where the catalog marks one, and a check on the current model.
// Like opencode, it shows the newest model of each family released in the
// last six months unless the user showed or hid models in settings.

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

export interface ModelList {
  models: ModelInfo[];
  /** Provider id → display name. */
  providers: Map<string, string>;
}

// One read per app run: the service's models change rarely, and every
// composer shares the list.
let pending: Promise<ModelList> | null = null;

function loadModels(): Promise<ModelList> {
  pending ??= Promise.all([ocClient.listProviders(), ocClient.listModels()])
    .then(([providers, models]) => ({
      providers: new Map(providers.map((p) => [p.id, p.name])),
      models: models.filter((m) => m.enabled && m.status !== "deprecated"),
    }))
    .catch((err: unknown) => {
      pending = null;
      throw err;
    });
  return pending;
}

/** The models the user's connected providers offer; null while loading. */
export function useModels(): ModelList | null {
  const [list, setList] = useState<ModelList | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadModels()
      .then((l) => {
        if (!cancelled) setList(l);
      })
      .catch((err: unknown) => console.warn("[models] list failed:", err));
    return () => {
      cancelled = true;
    };
  }, []);
  return list;
}

// Directory → its default model ref (a project can configure its own).
const defaults = new Map<string, Promise<string | null>>();

function loadDefault(directory: string): Promise<string | null> {
  let pending = defaults.get(directory);
  if (pending === undefined) {
    pending = ocClient
      .defaultModel(directory)
      .then((m) => (m ? formatModelRef(m.providerID, m.id) : null))
      .catch((err: unknown) => {
        defaults.delete(directory);
        throw err;
      });
    defaults.set(directory, pending);
  }
  return pending;
}

/**
 * The model a session in `directory` runs on when it names none, as a
 * `providerID/modelID` ref; null while loading or with no directory.
 */
export function useDefaultModel(directory: string | null): string | null {
  const [found, setFound] = useState<{ dir: string; ref: string | null }>();
  useEffect(() => {
    if (directory === null) return;
    let cancelled = false;
    loadDefault(directory)
      .then((ref) => {
        if (!cancelled) setFound({ dir: directory, ref });
      })
      .catch((err: unknown) => console.warn("[models] default failed:", err));
    return () => {
      cancelled = true;
    };
  }, [directory]);
  return found !== undefined && found.dir === directory ? found.ref : null;
}

const refOf = (m: ModelInfo) => formatModelRef(m.providerID, m.id);

export const isFreeModel = (m: ModelInfo) =>
  m.providerID === "opencode" && (m.cost[0]?.input ?? 0) === 0;

/** opencode marks a model the latest of its line with "(latest)" in its name. */
const isLatestTagged = (m: ModelInfo) => m.name.includes("(latest)");
const displayName = (m: ModelInfo) => m.name.replace("(latest)", "").trim();

/**
 * Refs shown by default: per provider, the newest model of each family
 * (free and paid twins apart) released in the last six months.
 */
export function newestOfFamilies(models: readonly ModelInfo[]): Set<string> {
  const newest = new Map<string, ModelInfo>();
  const now = Date.now();
  for (const m of models) {
    if (Math.abs(now - m.time.released) >= SIX_MONTHS) continue;
    const key = `${m.providerID}:${m.family ?? m.id}:${isFreeModel(m)}`;
    const current = newest.get(key);
    if (current === undefined || m.time.released > current.time.released)
      newest.set(key, m);
  }
  return new Set([...newest.values()].map(refOf));
}

export function isVisible(
  m: ModelInfo,
  latest: ReadonlySet<string>,
  visibility: { hidden: readonly string[]; shown: readonly string[] },
): boolean {
  const ref = refOf(m);
  if (visibility.hidden.includes(ref)) return false;
  if (visibility.shown.includes(ref)) return true;
  if (latest.has(ref)) return true;
  // Models without a release date stay visible.
  return !Number.isFinite(m.time.released) || m.time.released === 0;
}

function providerRank(id: string): number {
  const index = POPULAR_PROVIDERS.indexOf(id);
  return index < 0 ? POPULAR_PROVIDERS.length : index;
}

function sections(
  list: ModelList,
  current: string | null,
  visibility: Prefs["models"],
): SelectorSection[] {
  const latest = newestOfFamilies(list.models);
  const byProvider = new Map<string, ModelInfo[]>();
  for (const m of list.models) {
    // The current model always shows, hidden or not.
    if (refOf(m) !== current && !isVisible(m, latest, visibility)) continue;
    const group = byProvider.get(m.providerID) ?? [];
    group.push(m);
    byProvider.set(m.providerID, group);
  }
  return [...byProvider]
    .sort(
      ([a], [b]) =>
        providerRank(a) - providerRank(b) ||
        (list.providers.get(a) ?? a).localeCompare(list.providers.get(b) ?? b),
    )
    .map(([id, models]) => ({
      type: "section" as const,
      title: list.providers.get(id) ?? id,
      options: models
        .sort((a, b) => displayName(a).localeCompare(displayName(b)))
        .map((m) => ({
          value: refOf(m),
          label: displayName(m),
          // Carried for renderOption: which tags the row shows.
          description: [
            isFreeModel(m) ? "Free" : "",
            isLatestTagged(m) ? "Latest" : "",
          ]
            .filter(Boolean)
            .join(" "),
        })),
    }));
}

function ModelOption({ option }: { option: SelectorOptionData }) {
  const tags =
    typeof option.description === "string" && option.description !== ""
      ? option.description.split(" ")
      : [];
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 truncate">{option.label}</span>
      {tags.map((tag) => (
        <Badge key={tag} label={tag} />
      ))}
    </span>
  );
}

/**
 * `value` is a `providerID/modelID` ref, or null for "whatever the session
 * uses" (the trigger then reads "Model").
 */
export function ModelPicker({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (ref: string) => void;
}) {
  const list = useModels();
  const visibility = useSelector(prefs, (p) => p.models);
  return (
    <Selector
      label="Model"
      isLabelHidden
      variant="ghost"
      size="sm"
      hasSearch
      searchPlaceholder="Search models"
      emptySearchText="No models found"
      placeholder="Model"
      isLoading={list === null}
      options={list === null ? [] : sections(list, value, visibility)}
      renderOption={(option) => <ModelOption option={option} />}
      renderValue={(option) => option.label}
      {...(value !== null ? { value } : {})}
      onChange={onChange}
    />
  );
}

/** The model `ref` names in the list, if the list has it. */
export function findModel(
  list: ModelList | null,
  ref: string | null,
): ModelInfo | undefined {
  return ref === null ? undefined : list?.models.find((m) => refOf(m) === ref);
}

/** What `model` reads besides text; unknown models get text only. */
export function inputsOf(model: ModelInfo | undefined) {
  const input = model?.capabilities.input ?? [];
  return { image: input.includes("image"), pdf: input.includes("pdf") };
}

const titleCase = (s: string) =>
  s === "xhigh" ? "Extra high" : s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The reasoning effort picker, as opencode's: "Default" (no variant, the
 * model's own setting) and each variant the model lists; shift+mod+D
 * cycles them. Hidden for models without variants.
 */
export function VariantPicker({
  model,
  value,
  onChange,
}: {
  model: ModelInfo | undefined;
  /** A variant id, or "default". */
  value: string;
  onChange: (variant: string) => void;
}) {
  const ids = ["default", ...(model?.variants.map((v) => v.id) ?? [])];
  const current = ids.includes(value) ? value : "default";
  const cycle = useRef({ ids, current, onChange });
  cycle.current = { ids, current, onChange };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        !(e.metaKey || e.ctrlKey) ||
        !e.shiftKey ||
        e.key.toLowerCase() !== "d"
      )
        return;
      const { ids, current, onChange } = cycle.current;
      if (ids.length < 2) return;
      e.preventDefault();
      onChange(ids[(ids.indexOf(current) + 1) % ids.length] as string);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  if (ids.length < 2) return null;
  return (
    <Selector
      label="Reasoning effort"
      isLabelHidden
      variant="ghost"
      size="sm"
      options={ids.map((id) => ({
        value: id,
        label: id === "default" ? "Default" : titleCase(id),
      }))}
      value={current}
      onChange={onChange}
    />
  );
}
