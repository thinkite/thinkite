import { spawn } from "node:child_process";

export interface ContinueOnDesktopTarget {
  cliSessionId: string;
  /**
   * Desktop's local sessionId (e.g. "local_119c4694-..."). Pass it when the
   * session already has a corresponding `local_*.json` file — Desktop will
   * dedup against the existing entry and just navigate. For CLI-only
   * sessions (no Desktop mirror yet) leave it undefined.
   */
  desktopLocalSessionId?: string;
}

/**
 * Build the `claude://resume?session=...` deep link Desktop uses.
 *
 * Mechanism: Desktop's `importCliSession(A)` dedupes on `"local_" + A`. For
 * already-mirrored sessions we pass `desktopLocalSessionId` stripped of its
 * `"local_"` prefix → dedup hits → Desktop navigates to the existing entry,
 * no duplicate. For sessions Desktop hasn't seen, we pass `cliSessionId`
 * verbatim → dedup misses → Desktop runs the import flow.
 */
export function buildContinueDeepLink(target: ContinueOnDesktopTarget): string {
  const param = target.desktopLocalSessionId
    ? target.desktopLocalSessionId.replace(/^local_/, "")
    : target.cliSessionId;
  return `claude://resume?session=${encodeURIComponent(param)}`;
}

export type OpenRunner = (url: string) => Promise<number | null>;

const defaultRunner: OpenRunner = (url) =>
  new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/open", [url], { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", resolve);
  });

export async function continueOnDesktop(
  target: ContinueOnDesktopTarget,
  runner: OpenRunner = defaultRunner,
): Promise<void> {
  const url = buildContinueDeepLink(target);
  const exitCode = await runner(url);
  if (exitCode !== 0) {
    throw new Error(`'open ${url}' exited with code ${exitCode}`);
  }
}
