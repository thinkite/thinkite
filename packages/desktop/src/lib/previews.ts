import type { PreviewEntry } from "@thinkite/protocol";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { showBrowserPage } from "./browser";

// The servers the agent started in a folder, from the daemon's preview
// registry (/api/previews/events, docs/preview-tool-v1.md): one stream per
// folder however many views read it. The pages they serve open as the
// user's own tabs; after that the tabs are the user's, and nothing here
// moves, reloads or closes them.

interface Feed {
  source: EventSource;
  listeners: Set<() => void>;
}

const feeds = new Map<string, Feed>();
/** The last list per folder, kept after its stream closes, so a session
 *  screen that mounts again starts from it instead of empty. */
const latest = new Map<string, PreviewEntry[]>();
const EMPTY: PreviewEntry[] = [];

function subscribe(directory: string, listener: () => void): () => void {
  let feed = feeds.get(directory);
  if (feed === undefined) {
    const source = new EventSource(
      `/api/previews/events?directory=${encodeURIComponent(directory)}`,
    );
    const created: Feed = { source, listeners: new Set() };
    source.onmessage = (e: MessageEvent<string>) => {
      try {
        latest.set(directory, JSON.parse(e.data) as PreviewEntry[]);
      } catch {
        return;
      }
      for (const l of created.listeners) l();
    };
    feeds.set(directory, created);
    feed = created;
  }
  const current = feed;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size > 0) return;
    current.source.close();
    feeds.delete(directory);
  };
}

export function usePreviews(
  directory: string | null | undefined,
): PreviewEntry[] {
  const sub = useCallback(
    (listener: () => void) =>
      directory ? subscribe(directory, listener) : () => undefined,
    [directory],
  );
  return useSyncExternalStore(
    sub,
    () => (directory ? latest.get(directory) : undefined) ?? EMPTY,
  );
}

export const isLive = (e: PreviewEntry) => e.status === "running";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The Servers card's label for a page: `:5173` on this Mac, the host
 *  otherwise (a tunnel). */
export function serverLabel(url: string): string {
  try {
    const u = new URL(url);
    return LOOPBACK.has(u.hostname) ? `:${port(u)}` : u.host;
  } catch {
    return url;
  }
}

const port = (u: URL) => u.port || (u.protocol === "https:" ? "443" : "80");

/** One server for both URLs: the same origin, with localhost and
 *  127.0.0.1 counted as one host. */
function sameServer(a: string | undefined, b: string): boolean {
  if (a === undefined) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    if (LOOPBACK.has(x.hostname) && LOOPBACK.has(y.hostname))
      return x.protocol === y.protocol && port(x) === port(y);
    return x.origin === y.origin;
  } catch {
    return false;
  }
}

/** The Servers card's stop button. */
export async function stopPreview(
  directory: string,
  name: string,
): Promise<void> {
  const res = await fetch(
    `/api/previews/stop?directory=${encodeURIComponent(directory)}&name=${encodeURIComponent(name)}`,
    { method: "POST" },
  );
  if (!res.ok && res.status !== 404) throw new Error(await res.text());
}

// ─── The agent's requests to show a page ──────────────────────────────────
//
// An entry's `opened` stamp is the agent's latest request to show it. This
// device keeps, per folder and name, the last stamp it acted on, so a
// request made while another session was on screen is still acted on when
// the user comes to this one, and a tab the user closed stays closed until
// the agent asks again.

const HANDLED_KEY = "thinkite:previews-opened";

function loadHandled(): Record<string, number> {
  try {
    const raw = localStorage.getItem(HANDLED_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, number>);
  } catch {
    return {};
  }
}

const handled = loadHandled();
const handledKey = (directory: string, name: string) => `${directory}\0${name}`;

/** The running entries the agent asked to show in `sessionID` that this
 *  device has not acted on. */
export function dueToShow(
  entries: readonly PreviewEntry[],
  sessionID: string,
  handledAt: (name: string) => number | undefined,
): (PreviewEntry & { url: string })[] {
  return entries.filter(
    (e): e is PreviewEntry & { url: string } =>
      e.url !== undefined &&
      e.opened !== undefined &&
      e.opened.sessionID === sessionID &&
      e.opened.at > (handledAt(e.name) ?? 0) &&
      e.status === "running",
  );
}

/**
 * Act on the agent's requests for the session on screen: put each page in
 * a tab (lib/browser's showBrowserPage), then `onShow` (the browser view).
 */
export function usePreviewRequests(
  sessionID: string,
  directory: string | null | undefined,
  onShow: () => void,
): void {
  const entries = usePreviews(directory);
  const show = useRef(onShow);
  show.current = onShow;
  useEffect(() => {
    if (!directory) return;
    const due = dueToShow(
      entries,
      sessionID,
      (name) => handled[handledKey(directory, name)],
    );
    if (due.length === 0) return;
    for (const e of due) {
      // Recorded either way: with every tab taken, the Servers card still
      // opens it.
      showBrowserPage(sessionID, e.url);
      handled[handledKey(directory, e.name)] = e.opened?.at ?? 0;
    }
    try {
      localStorage.setItem(HANDLED_KEY, JSON.stringify(handled));
    } catch {
      // private window: requests are acted on again after a reload
    }
    show.current();
  }, [entries, sessionID, directory]);
}

/** The ended server whose page a tab at `url` shows, when nothing live
 *  serves it now: the tab's "web stopped" strip. */
export function stoppedServerAt(
  entries: readonly PreviewEntry[],
  url: string,
): PreviewEntry | undefined {
  if (entries.some((e) => isLive(e) && sameServer(e.url, url)))
    return undefined;
  return entries.find((e) => !isLive(e) && sameServer(e.url, url));
}
