// Session list client — a read-only mirror of the daemon's store
// (~/.sidecode/sessions/, sidecode-created sessions only). Create/delete
// arrive with the daemon RPC attachment; until then the sidebar just polls.

export interface SessionRow {
  /** Daemon session id (`local_<uuid>`) — also the PTY key. */
  id: string;
  /** Claude Code session uuid — keys the JSONL transcript. */
  claudeSessionId: string;
  title: string;
  cwd: string;
  createdAt: number;
  lastActivityAt: number;
  model: string | null;
  live: boolean;
}

export async function fetchSessions(): Promise<SessionRow[]> {
  const res = await fetch("/api/sessions");
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as SessionRow[];
}
