import type { PreviewEntry } from "@thinkite/protocol";
import { useCallback, useSyncExternalStore } from "react";

// The servers the agent started in a folder, from the daemon's preview
// registry (/api/previews/events, docs/preview-tool-v1.md): one stream per
// folder however many views read it. The agent shows the user a page by
// writing its link in a reply; a link to one of these servers' ports opens
// in the session's browser (`serverForLink`), any other in the user's.

interface Snapshot {
  entries: PreviewEntry[];
}

interface Feed {
  source: EventSource;
  listeners: Set<() => void>;
}

const feeds = new Map<string, Feed>();
/** The last snapshot per folder, kept after its stream closes, so a
 *  session screen that mounts again starts from it instead of empty. */
const latest = new Map<string, Snapshot>();
const EMPTY: Snapshot = { entries: [] };

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

/** The folder's servers. */
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
    () => ((directory ? latest.get(directory) : undefined) ?? EMPTY).entries,
  );
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
    case "unloaded":
      return "Closed by opencode";
    default:
      return "Killed";
  }
}

/** The port of a page on this Mac: loopback or `*.localhost`, where the
 *  servers' ports are. Undefined for any other host (a tunnel, a site). */
export function localPort(url: string): number | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host.startsWith("127.");
  if (!local) return undefined;
  return Number(u.port || (u.protocol === "https:" ? 443 : 80));
}

/** The Servers card's label for a server: its page's port, `:5173`. */
export function serverLabel(url: string): string {
  const port = localPort(url);
  return port === undefined ? url : `:${port}`;
}

/** The running server a link in a reply points at, by its port: the link
 *  opens in the session's browser. Any other link opens in the user's. */
export function serverForLink(
  entries: readonly PreviewEntry[],
  href: string,
): PreviewEntry | undefined {
  const port = localPort(href);
  if (port === undefined) return undefined;
  return entries.find((e) => isLive(e) && e.ports?.includes(port));
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

/** The ended server whose page a tab at `url` shows, when nothing live
 *  serves it now: the tab's "web stopped" strip. */
export function stoppedServerAt(
  entries: readonly PreviewEntry[],
  url: string,
): PreviewEntry | undefined {
  const port = localPort(url);
  if (port === undefined || serverForLink(entries, url)) return undefined;
  return entries.find((e) => !isLive(e) && e.ports?.includes(port));
}
