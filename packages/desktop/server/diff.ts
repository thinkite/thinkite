// GET /api/diff — one-shot working-tree diff for the Pierre diff panel.
//
// Deno port of the daemon's `GitWatcher.fetchDiff` (packages/daemon/src/
// git-watch.ts), kept response-shape-identical (`GitDiff`) on purpose: the
// endpoint is a P1 placeholder — once the desktop GUI attaches to the daemon
// (loopback transport, same router the iOS app speaks over WebRTC), the fetch
// swaps to that RPC and the panel doesn't change. Semantics mirror the daemon:
//
//   - tracked changes = `git diff <merge-base(defaultBranch, HEAD)>` — "what
//     this branch changed vs the default branch" (Claude Desktop / Paseo
//     convention), falling back to HEAD (uncommitted-only) when unresolvable
//   - untracked files = synthesized all-add patches (`git diff` never shows
//     them), with Paseo's caps: ≤500 files, ≤256 KiB each, null-byte sniff
const UNTRACKED_MAX_FILES = 500;
const UNTRACKED_MAX_FILE_BYTES = 256 * 1024;
const UNTRACKED_BINARY_SNIFF_BYTES = 512;

export interface GitDiff {
  isRepo: boolean;
  diff: string;
  fileCount: number;
  truncated: boolean;
}

async function git(dir: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: ["-C", dir, ...args],
    stdout: "piped",
    stderr: "null",
  }).output();
  if (!out.success) throw new Error(`git ${args[0]} failed`);
  return new TextDecoder().decode(out.stdout);
}

/** merge-base(defaultBranch, HEAD), falling back to HEAD — the same
 *  comparison ref the daemon's status bar numbers use. */
async function resolveComparisonRef(dir: string): Promise<string> {
  const defaultBranch = await resolveDefaultBranch(dir);
  if (defaultBranch === null) return "HEAD";
  try {
    const sha = (await git(dir, ["merge-base", defaultBranch, "HEAD"])).trim();
    return sha.length > 0 ? sha : "HEAD";
  } catch {
    return "HEAD";
  }
}

/** Target of origin/HEAD (preferring the local branch of the same name),
 *  else a local main/master, else null. */
async function resolveDefaultBranch(dir: string): Promise<string | null> {
  try {
    const ref = (
      await git(dir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
    ).trim();
    if (ref.length > 0) {
      const remoteShort = ref.replace(/^refs\/remotes\//, ""); // origin/main
      const localName = remoteShort.startsWith("origin/")
        ? remoteShort.slice("origin/".length)
        : remoteShort;
      try {
        await git(dir, [
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${localName}`,
        ]);
        return localName;
      } catch {
        return remoteShort; // not checked out locally
      }
    }
  } catch {
    // origin/HEAD not set — fall through.
  }
  try {
    const branches = new Set(
      (await git(dir, ["branch", "--format=%(refname:short)"]))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    );
    if (branches.has("main")) return "main";
    if (branches.has("master")) return "master";
  } catch {
    // no branches resolvable
  }
  return null;
}

/** Git-style all-add unified patch for an untracked file (`\n`-normalized). */
function synthesizeAddPatch(rel: string, content: string): string {
  const hasFinalNewline = content.endsWith("\n");
  const body = hasFinalNewline ? content.slice(0, -1) : content;
  const lines = body.split("\n");
  let patch =
    `diff --git a/${rel} b/${rel}\n` +
    "new file mode 100644\n" +
    "--- /dev/null\n" +
    `+++ b/${rel}\n` +
    `@@ -0,0 +1,${lines.length} @@\n` +
    lines.map((l) => `+${l}`).join("\n") +
    "\n";
  if (!hasFinalNewline) patch += "\\ No newline at end of file\n";
  return patch;
}

async function buildUntrackedDiff(
  dir: string,
): Promise<{ diff: string; truncated: boolean }> {
  let out = "";
  let truncated = false;
  try {
    const files = (
      await git(dir, ["ls-files", "--others", "--exclude-standard"])
    )
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    truncated = files.length > UNTRACKED_MAX_FILES;

    for (const rel of files.slice(0, UNTRACKED_MAX_FILES)) {
      try {
        const abs = `${dir}/${rel}`;
        const stat = await Deno.stat(abs);
        if (!stat.isFile || stat.size === 0) continue;
        if (stat.size > UNTRACKED_MAX_FILE_BYTES) {
          truncated = true;
          continue;
        }
        const bytes = await Deno.readFile(abs);
        if (
          bytes
            .subarray(0, UNTRACKED_BINARY_SNIFF_BYTES)
            .includes(0) // null byte = likely binary
        ) {
          continue;
        }
        const content = new TextDecoder("utf-8", { fatal: false })
          .decode(bytes)
          .replace(/\r\n/g, "\n");
        out += synthesizeAddPatch(rel, content);
      } catch {
        // permission denied, dangling symlink, … — skip
      }
    }
  } catch {
    // ls-files failed — treat as no untracked
  }
  return { diff: out, truncated };
}

export async function fetchDiff(dir: string): Promise<GitDiff> {
  let isRepo: boolean;
  try {
    isRepo =
      (await git(dir, ["rev-parse", "--is-inside-work-tree"])).trim() ===
      "true";
  } catch {
    isRepo = false;
  }
  if (!isRepo) return { isRepo: false, diff: "", fileCount: 0, truncated: false };

  const comparisonRef = await resolveComparisonRef(dir);
  const [tracked, untracked] = await Promise.all([
    git(dir, ["diff", comparisonRef]).catch(() => ""),
    buildUntrackedDiff(dir),
  ]);

  const diff = tracked + untracked.diff;
  return {
    isRepo: true,
    diff,
    // Only real file headers sit at column 0 (content lines carry a
    // space/+/- prefix), so this is exact.
    fileCount: (diff.match(/^diff --git /gm) ?? []).length,
    truncated: untracked.truncated,
  };
}

export async function handleDiff(req: Request): Promise<Response> {
  const dir = new URL(req.url).searchParams.get("dir") ?? Deno.cwd();
  // Loopback-local app (the PTY endpoint next door hands out a full shell),
  // so `dir` isn't a trust boundary — just require an absolute path that exists.
  if (!dir.startsWith("/")) {
    return new Response("dir must be absolute", { status: 400 });
  }
  try {
    const stat = await Deno.stat(dir);
    if (!stat.isDirectory) throw new Error("not a directory");
  } catch {
    return new Response("dir not found", { status: 404 });
  }
  return Response.json(await fetchDiff(dir));
}
