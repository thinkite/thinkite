import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * One Desktop-managed session, mirrored from a local_<uuid>.json file under
 * ~/Library/Application Support/Claude/claude-code-sessions/.
 *
 * The two enclosing UUIDs are per-environment (one Anthropic environmentId
 * per pair); they are NOT cwd-encoded. cwd lives inside the file body, so
 * filtering requires reading every candidate file.
 */
export interface DesktopSession {
  sessionId: string;
  cliSessionId: string;
  cwd: string;
  originCwd: string;
  createdAt: number;
  lastActivityAt: number;
  model: string;
  effort: string;
  isArchived: boolean;
  title: string;
  titleSource: string;
  permissionMode: string;
  completedTurns: number;
  filePath: string;
  environmentOuter: string;
  environmentInner: string;
}

const DEFAULT_REL_PATH =
  "Library/Application Support/Claude/claude-code-sessions";

export function desktopSessionsRoot(homeDirOverride?: string): string {
  return join(homeDirOverride ?? homedir(), DEFAULT_REL_PATH);
}

export interface ListOptions {
  /** When provided, only sessions whose `cwd` matches exactly are returned.
   *  When omitted, all sessions across all cwds + accounts are returned and
   *  the caller groups client-side. */
  cwd?: string;
  /** Override the sessions root directory (tests / fixtures). */
  rootOverride?: string;
}

/**
 * Return Desktop sessions sorted by lastActivityAt descending. Missing root
 * → []. Malformed files are skipped silently — a single corrupt JSON must
 * not break the whole listing.
 *
 * Dedup: Desktop keeps one `<outer>/<inner>` pair per Anthropic
 * environmentId. A user with multiple environments (e.g. work + personal)
 * gets the same CLI conversation mirrored under each env-pair, producing
 * duplicate rows on disk. We collapse to one record per `cliSessionId`
 * (the conversation's identity in `~/.claude/projects/`), keeping the
 * env-pair with the most recent `lastActivityAt` — the env the user is
 * actually working in.
 *
 * Why `cliSessionId` and not `sessionId`: today they're 1:1 (sessionId =
 * "local_" + cliSessionId), but that's Desktop's storage encoding, not
 * the conversation identity. If Desktop ever changes the local-id scheme
 * (or sidecode-created sessions land in V0.5+ with their own sessionId
 * for the same cliSessionId), keying on cliSessionId still collapses the
 * duplicate; sessionId would not.
 */
export async function listDesktopSessions(
  opts: ListOptions = {},
): Promise<DesktopSession[]> {
  const root = opts.rootOverride ?? desktopSessionsRoot();
  if (!(await isDir(root))) return [];

  const cwdFilter = opts.cwd;
  const byCliSessionId = new Map<string, DesktopSession>();
  for (const outer of await readdirSafe(root)) {
    const outerPath = join(root, outer);
    if (!(await isDir(outerPath))) continue;

    for (const inner of await readdirSafe(outerPath)) {
      const innerPath = join(outerPath, inner);
      if (!(await isDir(innerPath))) continue;

      for (const file of await readdirSafe(innerPath)) {
        if (!file.startsWith("local_") || !file.endsWith(".json")) continue;
        const filePath = join(innerPath, file);
        const session = await readSessionFile(filePath, outer, inner);
        if (!session) continue;
        if (cwdFilter !== undefined && session.cwd !== cwdFilter) continue;
        const prev = byCliSessionId.get(session.cliSessionId);
        if (!prev || session.lastActivityAt > prev.lastActivityAt) {
          byCliSessionId.set(session.cliSessionId, session);
        }
      }
    }
  }

  const results = Array.from(byCliSessionId.values());
  results.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return results;
}

async function readSessionFile(
  filePath: string,
  environmentOuter: string,
  environmentInner: string,
): Promise<DesktopSession | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (typeof data.cwd !== "string" || typeof data.sessionId !== "string") {
    return null;
  }
  // cliSessionId is the foreign key into ~/.claude/projects/<key>/<id>.jsonl —
  // without it we can't fetch the transcript via the SDK, so the session is
  // useless to iOS. Filter out (rather than emit empty-string) so the wire
  // contract can require it (see protocol.sessionInfo.cliSessionId).
  if (typeof data.cliSessionId !== "string" || data.cliSessionId === "") {
    return null;
  }

  return {
    sessionId: data.sessionId,
    cliSessionId: data.cliSessionId,
    cwd: data.cwd,
    originCwd: stringOr(data.originCwd, data.cwd),
    createdAt: numberOr(data.createdAt, 0),
    lastActivityAt: numberOr(data.lastActivityAt, 0),
    model: stringOr(data.model, ""),
    effort: stringOr(data.effort, ""),
    isArchived: data.isArchived === true,
    title: stringOr(data.title, ""),
    titleSource: stringOr(data.titleSource, ""),
    permissionMode: stringOr(data.permissionMode, ""),
    completedTurns: numberOr(data.completedTurns, 0),
    filePath,
    environmentOuter,
    environmentInner,
  };
}

function stringOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

async function isDir(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function readdirSafe(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}
