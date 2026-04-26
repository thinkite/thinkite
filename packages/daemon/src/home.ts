import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DIR_NAME = ".sidecode";

/**
 * Resolve the daemon's home directory and ensure it exists with 0700 perms.
 *
 * Lookup order:
 *   1. $SIDECODE_HOME env var, if set and non-empty
 *   2. <homeDirOverride>/.sidecode, if homeDirOverride passed (test escape hatch)
 *   3. ~/.sidecode (production default)
 */
export function resolveSidecodeHome(homeDirOverride?: string): string {
  const fromEnv = process.env.SIDECODE_HOME;
  const path =
    fromEnv && fromEnv.length > 0
      ? fromEnv
      : join(homeDirOverride ?? homedir(), DEFAULT_DIR_NAME);
  ensureDir(path);
  return path;
}

function ensureDir(path: string): void {
  let stat: ReturnType<typeof statSync> | undefined;
  try {
    stat = statSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return;
  }
  if (!stat.isDirectory()) {
    throw new Error(
      `SIDECODE_HOME path exists but is not a directory: ${path}`,
    );
  }
}
