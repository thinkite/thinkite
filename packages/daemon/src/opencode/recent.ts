import type { OpencodeConnection } from "./registry.ts";

/** One opencode session, as far as the folder picker cares. */
export interface RecentSession {
  directory: string;
  updatedAt: number;
}

/** The newest root sessions on the service (one page), for the picker's recents. */
export async function listRecentSessions(
  opencode: OpencodeConnection,
  fetchImpl: typeof fetch = fetch,
): Promise<RecentSession[]> {
  const url = new URL("/api/session", opencode.baseUrl);
  url.searchParams.set("limit", "100");
  const res = await fetchImpl(url, {
    headers: {
      authorization: `Basic ${Buffer.from(`${opencode.username}:${opencode.password}`).toString("base64")}`,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`opencode session list: ${res.status}`);
  const page = (await res.json()) as {
    data: Array<{
      parentID?: string;
      location: { directory: string };
      time: { updated: number };
    }>;
  };
  return page.data
    .filter((s) => s.parentID === undefined)
    .map((s) => ({
      directory: s.location.directory,
      updatedAt: s.time.updated,
    }));
}
