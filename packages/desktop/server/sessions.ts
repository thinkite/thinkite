// Read-only mirror of the daemon's session store (~/.sidecode/sessions/,
// JSON-per-session, daemon-owned). The GUI lists ONLY sidecode-created
// sessions — never the agent SDK's listSessions sweep (automation/test noise;
// same curation rule the iOS list settled on). Desktop reads, never writes:
// the daemon holds in-memory state for these records, so mutating the files
// behind its back would fork the two. Create/delete arrive with the daemon
// RPC attachment.
//
// The PTY layer stays: a terminal here is an attachment to the session's cwd,
// keyed by the daemon session id (server/pty.ts).
import { hasLivePty } from "./pty.ts";

/** Daemon record shape (packages/daemon persistence) — fields we consume. */
interface DaemonSessionRecord {
  sessionId: string;
  /** Claude Code session uuid — keys the JSONL transcript under ~/.claude. */
  cliSessionId: string;
  cwd: string;
  createdAt: number;
  lastActivityAt: number;
  isArchived: boolean;
  title?: string;
  model?: string;
}

const HOME = Deno.env.get("HOME") ?? ".";
const DAEMON_SESSIONS_DIR = `${HOME}/.sidecode/sessions`;

// Session ids are `local_<uuid>` today; keep the check shape-agnostic but
// path-safe (they become file names and PTY keys).
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

function parseRecord(text: string): DaemonSessionRecord | null {
  try {
    const j = JSON.parse(text);
    if (
      typeof j.sessionId === "string" &&
      SAFE_ID.test(j.sessionId) &&
      typeof j.cliSessionId === "string" &&
      typeof j.cwd === "string" &&
      j.cwd.startsWith("/")
    ) {
      return j as DaemonSessionRecord;
    }
  } catch {
    // malformed record — skip
  }
  return null;
}

async function listDaemonSessions(): Promise<DaemonSessionRecord[]> {
  const out: DaemonSessionRecord[] = [];
  try {
    for await (const e of Deno.readDir(DAEMON_SESSIONS_DIR)) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      const text = await Deno.readTextFile(
        `${DAEMON_SESSIONS_DIR}/${e.name}`,
      ).catch(() => null);
      const rec = text === null ? null : parseRecord(text);
      if (rec && !rec.isArchived) out.push(rec);
    }
  } catch {
    // no daemon store on this machine yet — empty list is the honest state
  }
  return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** Sync cwd lookup for PTY attach (server/pty.ts hook is synchronous).
 *  Attach is rare, so a per-call file read is fine. */
export function getSessionCwd(id: string): string | null {
  if (!SAFE_ID.test(id)) return null;
  try {
    const rec = parseRecord(
      Deno.readTextFileSync(`${DAEMON_SESSIONS_DIR}/${id}.json`),
    );
    return rec?.cwd ?? null;
  } catch {
    return null;
  }
}

export async function handleSessionsApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/api/sessions" && req.method === "GET") {
    const rows = (await listDaemonSessions()).map((r) => ({
      id: r.sessionId,
      claudeSessionId: r.cliSessionId,
      title: r.title?.trim() ||
        (r.cwd.split("/").filter(Boolean).at(-1) ?? r.cwd),
      cwd: r.cwd,
      createdAt: r.createdAt,
      lastActivityAt: r.lastActivityAt,
      model: r.model ?? null,
      live: hasLivePty(r.sessionId),
    }));
    return Response.json(rows);
  }
  return new Response("not found", { status: 404 });
}
