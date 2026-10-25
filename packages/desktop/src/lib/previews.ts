import type { BrowserRequest, PreviewEntry } from "@thinkite/protocol";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { showBrowserPage } from "./browser";

// The servers the agent started in a folder and the pages it asked to open,
// from the daemon's preview registry (/api/previews/events,
// docs/preview-tool-v1.md): one stream per folder however many views read
// it. The pages open as the user's own tabs; after that the tabs are the
// user's, and nothing here moves, reloads or closes them.

interface Snapshot {
  entries: PreviewEntry[];
  requests: BrowserRequest[];
}

interface Feed {
  source: EventSource;
  listeners: Set<() => void>;
}

const feeds = new Map<string, Feed>();
/** The last snapshot per folder, kept after its stream closes, so a
 *  session screen that mounts again starts from it instead of empty. */
const latest = new Map<string, Snapshot>();
const EMPTY: Snapshot = { entries: [], requests: [] };

function subscribe(directory: string, listener: () => void): () => void {
  let feed = feeds.get(directory);
  if (feed === undefined) {
    const source = new EventSource(
      `/api/previews/events?directory=${encodeURIComponent(directory)}`,
    );
    const created: Feed = { source, listeners: new Set() };
    source.onmessage = (e: MessageEvent<string>) => {
      try {
        latest.set(directory, JSON.parse(e.data) as Snapshot);
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

function useSnapshot(directory: string | null | undefined): Snapshot {
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

/** The folder's servers. */
export function usePreviews(
  directory: string | null | undefined,
): PreviewEntry[] {
  return useSnapshot(directory).entries;
}

export const isLive = (e: PreviewEntry) => e.status === "running";

/** A server's state in a word or two, with who stopped it. */
export function serverState(e: PreviewEntry): string {
  if (e.status === "running") return "Running";
  switch (e.ended?.by) {
    case "user":
      return "Stopped";
    case "agent":
      return "Stopped by agent";
    case "process":
      return e.ended.exit === undefined ? "Exited" : `Exited (${e.ended.exit})`;
    default:
      return "Killed";
  }
}

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

// ─── The agent's requests to open a page ──────────────────────────────────
//
// A request is the agent's latest ask to open a page, per session and
// origin. This device keeps, per folder, session and origin, the last
// request it acted on, so a request made while another session was on
// screen is still acted on when the user comes to this one, and a tab the
// user closed stays closed until the agent asks again.

const HANDLED_KEY = "thinkite:browser-requests";

function loadHandled(): Record<string, number> {
  try {
    const raw = localStorage.getItem(HANDLED_KEY);
    return raw === null ? {} : (JSON.parse(raw) as Record<string, number>);
  } catch {
    return {};
  }
}

const handled = loadHandled();

/** Per session and origin, as the daemon keeps them. */
export function requestKey(r: BrowserRequest): string {
  try {
    return `${r.sessionID}\0${new URL(r.url).origin}`;
  } catch {
    return `${r.sessionID}\0${r.url}`;
  }
}

/** The requests in `sessionID` this device has not acted on yet (all of
 *  them get recorded), and of those the ones to open: a page whose server
 *  has stopped since is not opened. */
export function dueToShow(
  snapshot: Snapshot,
  sessionID: string,
  handledAt: (key: string) => number | undefined,
): { pending: BrowserRequest[]; open: BrowserRequest[] } {
  const pending = snapshot.requests.filter(
    (r) => r.sessionID === sessionID && r.at > (handledAt(requestKey(r)) ?? 0),
  );
  const open = pending.filter(
    (r) =>
      r.server === undefined ||
      snapshot.entries.some((e) => e.name === r.server && isLive(e)),
  );
  return { pending, open };
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
  const snapshot = useSnapshot(directory);
  const show = useRef(onShow);
  show.current = onShow;
  useEffect(() => {
    if (!directory) return;
    const key = (k: string) => `${directory}\0${k}`;
    const { pending, open } = dueToShow(
      snapshot,
      sessionID,
      (k) => handled[key(k)],
    );
    if (pending.length === 0) return;
    // Recorded whether or not a tab was made: with every tab taken, the
    // Servers card still opens it.
    for (const r of open) showBrowserPage(sessionID, r.url);
    for (const r of pending) handled[key(requestKey(r))] = r.at;
    try {
      localStorage.setItem(HANDLED_KEY, JSON.stringify(handled));
    } catch {
      // private window: requests are acted on again after a reload
    }
    if (open.length > 0) show.current();
  }, [snapshot, sessionID, directory]);
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
