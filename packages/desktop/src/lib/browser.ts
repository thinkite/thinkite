import { createAtom } from "@tanstack/store";

// Each chat session's browser tabs (components/BrowserPanel). Pages don't
// outlive the window, so each tab keeps its address and title in
// localStorage, and opens there again after a reload.

export const MAX_BROWSER_TABS = 8;

export interface BrowserTab {
  n: number;
  url: string;
  title: string;
}

export interface BrowserTabs {
  open: BrowserTab[];
  active: number;
}

const KEY = "thinkite:browser";
const BLANK = "about:blank";

function load(): Record<string, BrowserTabs> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, BrowserTabs>);
  } catch {
    return {};
  }
}

export const browserTabs = createAtom<Record<string, BrowserTabs>>(load());
browserTabs.subscribe((all) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // private window: tabs just don't survive a reload
  }
});

/** A session's tabs; one blank tab until the user opens more. */
export const browserTabsOf = (
  all: Record<string, BrowserTabs>,
  sessionID: string,
): BrowserTabs =>
  all[sessionID] ?? { open: [{ n: 1, url: BLANK, title: "" }], active: 1 };

function update(sessionID: string, next: (t: BrowserTabs) => BrowserTabs) {
  browserTabs.set((all) => ({
    ...all,
    [sessionID]: next(browserTabsOf(all, sessionID)),
  }));
}

/** Open a tab after the others, at `url` or blank, and switch to it. */
export function openBrowserTab(sessionID: string, url = BLANK) {
  update(sessionID, (t) => {
    if (t.open.length >= MAX_BROWSER_TABS) return t;
    const n = Math.max(0, ...t.open.map((x) => x.n)) + 1;
    return { open: [...t.open, { n, url, title: "" }], active: n };
  });
}

export function selectBrowserTab(sessionID: string, n: number) {
  update(sessionID, (t) => ({ ...t, active: n }));
}

/** Record where a tab's page went, and what it is called. */
export function updateBrowserTab(
  sessionID: string,
  n: number,
  page: Partial<Pick<BrowserTab, "url" | "title">>,
) {
  update(sessionID, (t) => ({
    ...t,
    open: t.open.map((x) => (x.n === n ? { ...x, ...page } : x)),
  }));
}

/** Close a tab; the neighbour takes over. */
export function closeBrowserTab(sessionID: string, n: number) {
  update(sessionID, (t) => {
    const i = t.open.findIndex((x) => x.n === n);
    if (i === -1) return t;
    const open = t.open.filter((x) => x.n !== n);
    const active =
      t.active !== n ? t.active : (open[Math.min(i, open.length - 1)]?.n ?? 0);
    return { open, active };
  });
}

/** Forget a session's tabs (it was deleted or archived). */
export function forgetBrowserTabs(sessionID: string) {
  browserTabs.set((all) => {
    if (!(sessionID in all)) return all;
    const { [sessionID]: _, ...rest } = all;
    return rest;
  });
}

/**
 * What the address bar's text means: a URL as typed when it has a scheme;
 * `localhost` and bare IPs over http, other hosts over https; anything else
 * (spaces, no dot) a web search.
 */
export function addressToUrl(text: string): string {
  const t = text.trim();
  if (t === "") return BLANK;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) && !/^[^/]+:\d+/.test(t)) return t;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/|$)/i.test(t))
    return `http://${t}`;
  if (!/\s/.test(t) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/|$)/i.test(t))
    return `https://${t}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(t)}`;
}
