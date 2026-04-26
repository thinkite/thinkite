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

const DEFAULT_REL_PATH = "Library/Application Support/Claude/claude-code-sessions";

export function desktopSessionsRoot(homeDirOverride?: string): string {
  return join(homeDirOverride ?? homedir(), DEFAULT_REL_PATH);
}

export interface ListOptions {
  cwd: string;
  /** Override the sessions root directory (tests / fixtures). */
  rootOverride?: string;
}

/**
 * Return all Desktop sessions whose `cwd` matches exactly. Sorted by
 * lastActivityAt descending. Missing root → []. Malformed files are skipped
 * silently — a single corrupt JSON must not break the whole listing.
 */
export async function listDesktopSessions(
  opts: ListOptions,
): Promise<DesktopSession[]> {
  const root = opts.rootOverride ?? desktopSessionsRoot();
  if (!(await isDir(root))) return [];

  const results: DesktopSession[] = [];
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
        if (session && session.cwd === opts.cwd) results.push(session);
      }
    }
  }

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

  return {
    sessionId: data.sessionId,
    cliSessionId: stringOr(data.cliSessionId, ""),
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
