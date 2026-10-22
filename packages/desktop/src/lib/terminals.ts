import { createAtom } from "@tanstack/store";

// Each chat session's terminals, as tabs. The shells live in the main
// process (server/pty.ts) and outlive a renderer reload, so the tab list is
// kept in localStorage to re-attach the same shells after one. A terminal's
// pty name is the session id for the first, `<session id>-<n>` after it,
// which is how the server finds all of a session's shells to end them.

export const MAX_TERMINALS = 8;

export interface Terminals {
  /** Tab order; numbers name the pty and label the tab. */
  open: number[];
  active: number;
}

const KEY = "thinkite:terminals";

function load(): Record<string, Terminals> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, Terminals>);
  } catch {
    return {};
  }
}

export const terminals = createAtom<Record<string, Terminals>>(load());
terminals.subscribe((all) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // private window: tabs just don't survive a reload
  }
});

/** The pty name of a session's terminal `n`. */
export const ptyName = (sessionID: string, n: number) =>
  n === 1 ? sessionID : `${sessionID}-${n}`;

/** A session's tabs; one terminal until the user opens more. */
export const terminalsOf = (
  all: Record<string, Terminals>,
  sessionID: string,
): Terminals => all[sessionID] ?? { open: [1], active: 1 };

function update(sessionID: string, next: (t: Terminals) => Terminals) {
  terminals.set((all) => ({
    ...all,
    [sessionID]: next(terminalsOf(all, sessionID)),
  }));
}

/** Open a new terminal after the others and switch to it. */
export function openTerminal(sessionID: string) {
  update(sessionID, (t) => {
    if (t.open.length >= MAX_TERMINALS) return t;
    const n = Math.max(0, ...t.open) + 1;
    return { open: [...t.open, n], active: n };
  });
}

export function selectTerminal(sessionID: string, n: number) {
  update(sessionID, (t) => ({ ...t, active: n }));
}

/** Drop a tab (its shell was ended or exited); the neighbour takes over. */
export function dropTerminal(sessionID: string, n: number) {
  update(sessionID, (t) => {
    const i = t.open.indexOf(n);
    if (i === -1) return t;
    const open = t.open.filter((x) => x !== n);
    const active =
      t.active !== n ? t.active : (open[Math.min(i, open.length - 1)] ?? 0);
    return { open, active };
  });
}

/** Close a tab and end its shell. */
export function closeTerminal(sessionID: string, n: number) {
  void fetch(`/api/pty/kill?name=${ptyName(sessionID, n)}`, {
    method: "POST",
  }).catch(() => {});
  dropTerminal(sessionID, n);
}

/** Forget a session's tabs (it was deleted or archived). */
export function forgetTerminals(sessionID: string) {
  terminals.set((all) => {
    if (!(sessionID in all)) return all;
    const { [sessionID]: _, ...rest } = all;
    return rest;
  });
}
