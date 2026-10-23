import { createAtom, useSelector } from "@tanstack/react-store";
import {
  formatModelRef,
  type ModelInfo,
  type ModelRef,
  parseModelRef,
} from "@thinkite/oc-client";
import {
  useLastUsedModel,
  useMessages,
  useSession,
} from "@thinkite/oc-client/react";
import { useEffect } from "react";
import { useOcDefaultModel, useOcModels } from "@/hooks/use-oc-models";
import { getOcClient, ocStore } from "@/lib/oc";

// The model and reasoning effort a composer runs on, shared by the composer's
// chip and the model-picker sheet (a route of its own, so the pick lives
// here rather than in either). Picks wait in an atom by session — "new" for
// the new-session draft — until the service reports them: a session's pick
// switches it right away and goes once its model.selected event lands; the
// draft rides out on create.

interface Pick {
  model: string;
  /** A variant id, or "default" for none. */
  variant: string;
}

const NEW_SESSION = "new";
const picks = createAtom<Record<string, Pick>>({});
const keyOf = (sessionID: string | null) => sessionID ?? NEW_SESSION;

function setPick(key: string, pick: Pick | undefined) {
  picks.set((all) => {
    if (pick !== undefined) return { ...all, [key]: pick };
    if (!(key in all)) return all;
    const { [key]: _, ...rest } = all;
    return rest;
  });
}

/** `providerID/modelID` and a variant as the service takes them. */
export function modelRef(ref: string, variant: string): ModelRef {
  return {
    ...parseModelRef(ref),
    ...(variant !== "default" ? { variant } : {}),
  };
}

export interface ModelChoice {
  models: ModelInfo[];
  /** `providerID/modelID`, or null while loading. */
  model: string | null;
  /** A variant id, or "default". */
  variant: string;
  info: ModelInfo | undefined;
  /** The new-session draft differs from what the store would pin. */
  isPicked: boolean;
}

/**
 * What a composer runs on. A session: its pending pick, else its model,
 * else (made before new ones were pinned) the folder's default. The new
 * session: the draft, else the last used model and its variant, else the
 * folder's default — what the store pins on create.
 */
export function useModelChoice(
  sessionID: string | null,
  directory?: string,
): ModelChoice {
  const models = useOcModels();
  const session = useSession(ocStore, sessionID);
  const pick = useSelector(picks, (all) => all[keyOf(sessionID)]);
  const lastUsed = useLastUsedModel(ocStore);
  const lastVariant = useSelector(ocStore.lastUsedModel, (m) => m?.variant);
  const sessionModel =
    session?.model !== undefined
      ? formatModelRef(session.model.providerID, session.model.id)
      : null;
  const sessionVariant = session?.model?.variant ?? "default";
  const pinned = sessionID === null ? lastUsed : sessionModel;
  const defaultModel = useOcDefaultModel(
    (pick?.model ?? pinned) === null
      ? (session?.location.directory ?? directory)
      : undefined,
  );
  const model = pick?.model ?? pinned ?? defaultModel;
  const variant =
    pick?.variant ??
    (sessionID === null
      ? lastUsed !== null
        ? (lastVariant ?? "default")
        : "default"
      : sessionVariant);

  // The service has the session's pick: its own model shows from here on.
  useEffect(() => {
    if (
      sessionID !== null &&
      pick !== undefined &&
      pick.model === sessionModel &&
      pick.variant === sessionVariant
    )
      setPick(sessionID, undefined);
  }, [sessionID, pick, sessionModel, sessionVariant]);

  return {
    models,
    model,
    variant,
    info: models.find((m) => formatModelRef(m.providerID, m.id) === model),
    isPicked: sessionID === null && pick !== undefined,
  };
}

/**
 * Pick a model and effort. On a session it switches right away and the
 * pick shows until the service confirms it (or is dropped if the switch
 * fails); on the new session it waits for create.
 */
export function pickModel(
  sessionID: string | null,
  ref: string,
  variant: string,
): void {
  const key = keyOf(sessionID);
  const previous = picks.get()[key];
  setPick(key, { model: ref, variant });
  if (sessionID === null) return;
  getOcClient()
    .switchModel(sessionID, modelRef(ref, variant))
    .catch((err: unknown) => {
      console.error("model switch failed", err);
      setPick(key, previous);
    });
}

export interface ContextUsage {
  used: number;
  max: number;
  percentage: number;
}

/** How much of the model's context window the session's last turn used;
 *  undefined before the first turn, on the new session, or without a
 *  known window. */
export function useContextUsage(
  sessionID: string | null,
  max: number | undefined,
): ContextUsage | undefined {
  const messages = useMessages(ocStore, sessionID);
  if (sessionID === null || max === undefined || max <= 0) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.type !== "assistant" || m.tokens === undefined) continue;
    const t = m.tokens;
    const used =
      t.input + t.output + t.reasoning + t.cache.read + t.cache.write;
    return { used, max, percentage: Math.min(100, (used / max) * 100) };
  }
  return undefined;
}

/** A token count, short: "145k", "1M", "1.5M". Rounds rather than floors
 *  so it tracks intuition near boundaries; drops a trailing ".0". */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
  return `${Math.round(n / 1000)}k`;
}

/** The new session was created with the draft: start the next one fresh. */
export function clearNewSessionPick(): void {
  setPick(NEW_SESSION, undefined);
}
