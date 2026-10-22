import { createAtom } from "@tanstack/store";

// Client-side preferences, kept in localStorage like opencode desktop keeps
// its own (the service has no place for them). One atom, so every view that
// reads a pref re-renders when settings change it.

export interface Prefs {
  models: {
    /** `providerID/modelID` refs the user hid from the picker. */
    hidden: string[];
    /** Refs the user showed although they are not the latest of their family. */
    shown: string[];
  };
}

const KEY = "thinkite:prefs";
const DEFAULTS: Prefs = { models: { hidden: [], shown: [] } };

function load(): Prefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Prefs>;
    return {
      ...DEFAULTS,
      ...parsed,
      models: { ...DEFAULTS.models, ...parsed.models },
    };
  } catch {
    return DEFAULTS;
  }
}

export const prefs = createAtom<Prefs>(load());

export function updatePrefs(update: (current: Prefs) => Prefs): void {
  prefs.set(update);
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs.get()));
  } catch {
    // Private mode: the change still holds for this run.
  }
}
