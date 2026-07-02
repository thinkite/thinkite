// Desktop-local session store — a session is a cwd bookmark plus a lazily
// spawned PTY (server/pty.ts). Persisted as ONE JSON file under
// ~/.sidecode/desktop/, deliberately separate from the daemon's
// ~/.sidecode/sessions/ (Claude sessions, daemon-owned): those are only READ
// here, to seed new-session cwd candidates ("projects you've used Claude
// in"). When the GUI later attaches to the daemon, Claude sessions arrive as
// their own layer — this store keeps owning the local-terminal layer.
import { hasLivePty, killPty } from "./pty.ts";

export interface DesktopSession {
  id: string;
  /** Absolute path; validated to exist at creation. PTY spawns here and the
   *  diff panel diffs here. */
  cwd: string;
  /** Defaults to basename(cwd). */
  name: string;
  createdAt: number;
  /** ms epoch, bumped on PTY input/output (throttled). */
  lastActivityAt: number;
}

const HOME = Deno.env.get("HOME") ?? ".";
const STORE_DIR = `${HOME}/.sidecode/desktop`;
const STORE_FILE = `${STORE_DIR}/sessions.json`;
const DAEMON_SESSIONS_DIR = `${HOME}/.sidecode/sessions`;
const TOUCH_THROTTLE_MS = 5_000;

let sessions: DesktopSession[] = await (async () => {
  try {
    const arr = JSON.parse(await Deno.readTextFile(STORE_FILE));
    return Array.isArray(arr) ? (arr as DesktopSession[]) : [];
  } catch {
    return []; // first run / unreadable — start empty
  }
})();

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSave(delay = 500) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void save();
  }, delay);
}
async function save() {
  try {
    await Deno.mkdir(STORE_DIR, { recursive: true });
    await Deno.writeTextFile(STORE_FILE, JSON.stringify(sessions, null, 2));
  } catch (e) {
    console.error("session store save failed:", e);
  }
}

export function getSession(id: string): DesktopSession | undefined {
  return sessions.find((s) => s.id === id);
}

/** PTY activity → lastActivityAt. Throttled — a busy shell would otherwise
 *  rewrite the store on every output chunk. */
export function touchSession(id: string): void {
  const s = getSession(id);
  if (!s) return;
  const now = Date.now();
  if (now - s.lastActivityAt < TOUCH_THROTTLE_MS) return;
  s.lastActivityAt = now;
  scheduleSave();
}

interface ProjectCandidate {
  cwd: string;
  lastActivityAt: number;
}

/** New-session cwd candidates: every cwd the daemon's Claude sessions have
 *  touched (read-only scan) + our own sessions', newest activity first,
 *  existing directories only. */
async function listProjects(): Promise<ProjectCandidate[]> {
  const byCwd = new Map<string, number>();
  try {
    for await (const e of Deno.readDir(DAEMON_SESSIONS_DIR)) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      try {
        const j = JSON.parse(
          await Deno.readTextFile(`${DAEMON_SESSIONS_DIR}/${e.name}`),
        );
        if (typeof j.cwd === "string" && j.cwd.startsWith("/")) {
          const at = typeof j.lastActivityAt === "number" ? j.lastActivityAt : 0;
          byCwd.set(j.cwd, Math.max(byCwd.get(j.cwd) ?? 0, at));
        }
      } catch {
        // skip malformed record
      }
    }
  } catch {
    // no daemon store on this machine yet — candidates come from our own
  }
  for (const s of sessions) {
    byCwd.set(s.cwd, Math.max(byCwd.get(s.cwd) ?? 0, s.lastActivityAt));
  }
  const out: ProjectCandidate[] = [];
  for (const [cwd, lastActivityAt] of byCwd) {
    const stat = await Deno.stat(cwd).catch(() => null);
    if (stat?.isDirectory) out.push({ cwd, lastActivityAt });
  }
  return out.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

/** Native macOS folder picker (NSOpenPanel via osascript) — the webview can't
 *  do this itself: File objects in WKWebView never expose absolute paths, and
 *  laufey has no file-dialog binding (only alert/confirm/prompt). Blocks
 *  until the user picks or cancels. */
async function pickDirectory(): Promise<Response> {
  // No custom prompt: StandardAdditions' default panel text is fully
  // localized by the system; a hardcoded English prompt isn't.
  const out = await new Deno.Command("osascript", {
    args: ["-e", "POSIX path of (choose folder)"],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!out.success) return Response.json({ canceled: true }); // user canceled
  const path = new TextDecoder()
    .decode(out.stdout)
    .trim()
    .replace(/\/+$/, "");
  return Response.json({ path });
}

export async function handleSessionsApi(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/api/projects" && req.method === "GET") {
    return Response.json(await listProjects());
  }
  if (url.pathname === "/api/pick-dir" && req.method === "POST") {
    return await pickDirectory();
  }
  const m = url.pathname.match(/^\/api\/sessions(?:\/([A-Za-z0-9-]+))?$/);
  if (!m) return new Response("not found", { status: 404 });
  const id = m[1];

  if (req.method === "GET" && id === undefined) {
    // Flat list, newest activity first (same ordering the iOS list settled on).
    const rows = sessions
      .map((s) => ({ ...s, live: hasLivePty(s.id) }))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    return Response.json(rows);
  }

  if (req.method === "POST" && id === undefined) {
    let body: { cwd?: unknown; name?: unknown };
    try {
      body = await req.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const cwd = typeof body.cwd === "string" ? body.cwd : "";
    if (!cwd.startsWith("/")) {
      return new Response("cwd must be an absolute path", { status: 400 });
    }
    const stat = await Deno.stat(cwd).catch(() => null);
    if (!stat?.isDirectory) {
      return new Response("directory not found", { status: 404 });
    }
    const now = Date.now();
    const session: DesktopSession = {
      id: crypto.randomUUID(),
      cwd,
      name:
        typeof body.name === "string" && body.name.trim().length > 0
          ? body.name.trim()
          : (cwd.split("/").filter(Boolean).at(-1) ?? cwd),
      createdAt: now,
      lastActivityAt: now,
    };
    sessions.push(session);
    scheduleSave(0);
    return Response.json(session, { status: 201 });
  }

  if (req.method === "DELETE" && id !== undefined) {
    const i = sessions.findIndex((s) => s.id === id);
    if (i < 0) return new Response("not found", { status: 404 });
    killPty(id); // our PTY + our record only — never touches daemon sessions
    sessions.splice(i, 1);
    scheduleSave(0);
    return new Response(null, { status: 204 });
  }

  return new Response("method not allowed", { status: 405 });
}
