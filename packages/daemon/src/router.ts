import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DirectoryEntry } from "@thinkite/protocol";
import type { CommandHandler } from "./command.ts";
import type { GitWatcherRegistry } from "./git-watch.ts";
import type { RecentSession } from "./opencode/recent.ts";
import type { PreviewRegistry } from "./preview/registry.ts";

export interface RouterDeps {
  /**
   * Per-daemon registry of `GitWatcher`s keyed by `cwd`. Shared across
   * connections so two iOS clients on the same project re-use one watch
   * + cache. Daemon disposes the whole registry on shutdown.
   */
  gitWatchers: GitWatcherRegistry;
  /** Recent sessions on the user's opencode service, for the picker's recents. */
  recentSessions: () => Promise<RecentSession[]>;
  /** Servers the agent started and pages it opened, with the preview
   *  tools. Absent: the preview commands answer `unsupported`. */
  previews?: PreviewRegistry;
}

// Per-connection ctx.state key: ctx.state is a free-form Map scoped to the
// connection, and everything router-side is namespaced under "router:".
const GIT_SUBS_KEY = "router:gitSubs";

/** Per-conn map: cwd → unsubscribe-fn returned by GitWatcher.subscribe. */
type GitSubsMap = Map<string, () => void>;

// Per-conn preview subscriptions: directory → unsubscribe, plus the
// forward-port list under a key no directory can have.
const PREVIEW_SUBS_KEY = "router:previewSubs";
const FORWARD_PORTS_SUB = "\0forwardPorts";

type PreviewSubs = Map<string, () => void>;

function getOrCreatePreviewSubs(
  ctx: Parameters<CommandHandler>[1],
): PreviewSubs {
  const existing = ctx.state.get(PREVIEW_SUBS_KEY) as PreviewSubs | undefined;
  if (existing !== undefined) return existing;
  const created: PreviewSubs = new Map();
  ctx.state.set(PREVIEW_SUBS_KEY, created);
  ctx.onDisconnect(() => {
    for (const unsubscribe of created.values()) unsubscribe();
    created.clear();
  });
  return created;
}

function getOrCreateGitSubs(ctx: { state: Map<string, unknown> }): GitSubsMap {
  const existing = ctx.state.get(GIT_SUBS_KEY) as GitSubsMap | undefined;
  if (existing !== undefined) return existing;
  const created: GitSubsMap = new Map();
  ctx.state.set(GIT_SUBS_KEY, created);
  return created;
}

/**
 * The daemon's own RPC: a folder's git changes as they happen, the folder
 * picker, the servers the agent started and pages it opened (previews),
 * and the ports to forward. Sessions, prompts
 * and transcripts are opencode's, reached over the HTTP tunnel instead.
 *
 * Other command types are answered with an `unsupported` error frame so a
 * client fails loudly rather than hanging on a silently-dropped request.
 */
export function createCommandHandler(deps: RouterDeps): CommandHandler {
  return async (cmd, ctx) => {
    switch (cmd.type) {
      case "subscribeGitStatus": {
        // Pure change-stream registration — NO initial snapshot. Clients
        // read the repository from opencode's `vcs` and take each push as
        // "changed, read again" (the desktop through `watchGit`).
        try {
          const watcher = deps.gitWatchers.getOrCreate(cmd.cwd);
          const gitSubs = getOrCreateGitSubs(ctx);

          // Re-subscribe to the same cwd on the same conn replaces the old
          // listener — mirrors the `subscribe` handler's behavior for
          // session subs (rapid navigate-away-and-back).
          const previous = gitSubs.get(cmd.cwd);
          if (previous !== undefined) previous();

          const cwd = cmd.cwd;
          const unsubscribe = watcher.subscribe((status) => {
            ctx.send({ type: "gitStatus", cwd, status });
          });
          gitSubs.set(cwd, unsubscribe);
          // Auto-clean on DC.close. The closure is idempotent (GitWatcher
          // tolerates double-delete), so an explicit unsubscribeGitStatus
          // followed by DC.close is fine.
          ctx.onDisconnect(unsubscribe);

          ctx.send({
            type: "subscribeGitStatus.response",
            requestId: cmd.requestId,
            cwd,
          });
        } catch (err) {
          ctx.send({
            type: "error",
            requestId: cmd.requestId,
            code: "internal",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "unsubscribeGitStatus": {
        const gitSubs = getOrCreateGitSubs(ctx);
        const unsubscribe = gitSubs.get(cmd.cwd);
        if (unsubscribe !== undefined) {
          unsubscribe();
          gitSubs.delete(cmd.cwd);
        }
        ctx.send({
          type: "unsubscribeGitStatus.response",
          requestId: cmd.requestId,
        });
        return;
      }
      case "listDirectory": {
        // Hierarchical browser for the iOS cwd / file picker. Workhorse
        // RPC: caller passes the path it wants to list (or "~" / "~/..."
        // for HOME-relative), daemon returns one level of entries.
        //
        // V0 scope: folder picker. `includeFiles=true` already surfaces
        // file entries through the filter below, but `size` /
        // `modifiedAt` stay undefined — per-entry stat is deferred to
        // V0.5+ when we decide between per-call stat, lazy-on-visible-
        // row, or native bulk-stat (see "高效拿 stats" design thread).
        const resolved = expandHomePath(cmd.path);
        try {
          const stat = await fs.stat(resolved);
          if (!stat.isDirectory()) {
            ctx.send({
              type: "error",
              requestId: cmd.requestId,
              code: "not_a_directory",
              message: `${resolved} is not a directory`,
            });
            return;
          }
          const dirents = await fs.readdir(resolved, { withFileTypes: true });
          // Cheap filter — only name + d_type from readdir, no extra
          // syscall. Order matters: dot-filter before file-filter so
          // an `includeHidden: true, includeFiles: false` request
          // still drops hidden FILES implicitly via the kind filter.
          const entries: DirectoryEntry[] = dirents
            .filter((d) => cmd.includeHidden || !d.name.startsWith("."))
            .filter((d) => cmd.includeFiles || d.isDirectory())
            .map((d) => ({
              name: d.name,
              path: path.join(resolved, d.name),
              kind: d.isDirectory()
                ? ("directory" as const)
                : ("file" as const),
            }));
          entries.sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
            return a.name.localeCompare(b.name, undefined, {
              sensitivity: "base",
            });
          });
          // path.dirname("/") === "/" — that's our "at root" signal.
          const parentPath = path.dirname(resolved);
          ctx.send({
            type: "listDirectory.response",
            requestId: cmd.requestId,
            path: resolved,
            parent: parentPath === resolved ? null : parentPath,
            entries,
          });
        } catch (err) {
          const { code, message } = classifyFsError(err, resolved);
          ctx.send({ type: "error", requestId: cmd.requestId, code, message });
        }
        return;
      }
      case "getFilesystemRoots": {
        // Bootstrap RPC iOS calls once per session-create flow. Tells iOS
        // the daemon machine's HOME (so "~" expansion is server-side) +
        // gives the folders of recent opencode sessions so the picker has
        // a useful starting point.
        //
        // desktop/documents are stat-checked: macOS always has both,
        // but Linux headless / non-standard XDG locales may not — we
        // omit the field rather than send a path that 404s when iOS
        // tries to listDirectory on it.
        const home = os.homedir();
        try {
          const desktopPath = path.join(home, "Desktop");
          const documentsPath = path.join(home, "Documents");
          const [recentCwds, desktopExists, documentsExists] =
            await Promise.all([
              recentDirectories(deps),
              fs
                .stat(desktopPath)
                .then((s) => s.isDirectory())
                .catch(() => false),
              fs
                .stat(documentsPath)
                .then((s) => s.isDirectory())
                .catch(() => false),
            ]);
          ctx.send({
            type: "getFilesystemRoots.response",
            requestId: cmd.requestId,
            home,
            ...(desktopExists ? { desktop: desktopPath } : {}),
            ...(documentsExists ? { documents: documentsPath } : {}),
            recentCwds,
          });
        } catch (err) {
          ctx.send({
            type: "error",
            requestId: cmd.requestId,
            code: "internal",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      case "getPreviews":
      case "subscribePreviews":
      case "unsubscribePreviews":
      case "stopPreview":
      case "getForwardPorts":
      case "subscribeForwardPorts":
      case "unsubscribeForwardPorts": {
        const previews = deps.previews;
        if (previews === undefined) {
          ctx.send({
            type: "error",
            requestId: cmd.requestId,
            code: "unsupported",
            message: "previews are not available on this daemon",
          });
          return;
        }
        try {
          if (cmd.type === "getPreviews") {
            ctx.send({
              type: "getPreviews.response",
              requestId: cmd.requestId,
              directory: cmd.directory,
              ...(await previews.snapshot(cmd.directory)),
            });
          } else if (cmd.type === "subscribePreviews") {
            // Pure change stream, like subscribeGitStatus: the snapshot is
            // `getPreviews`. Re-subscribing a directory replaces the listener.
            const subs = getOrCreatePreviewSubs(ctx);
            subs.get(cmd.directory)?.();
            const directory = cmd.directory;
            subs.set(
              directory,
              previews.subscribe(directory, (snapshot) =>
                ctx.send({ type: "previews", directory, ...snapshot }),
              ),
            );
            ctx.send({
              type: "subscribePreviews.response",
              requestId: cmd.requestId,
              directory,
            });
          } else if (cmd.type === "unsubscribePreviews") {
            const subs = ctx.state.get(PREVIEW_SUBS_KEY) as
              | PreviewSubs
              | undefined;
            subs?.get(cmd.directory)?.();
            subs?.delete(cmd.directory);
            ctx.send({
              type: "unsubscribePreviews.response",
              requestId: cmd.requestId,
            });
          } else if (cmd.type === "getForwardPorts") {
            ctx.send({
              type: "getForwardPorts.response",
              requestId: cmd.requestId,
              ports: await previews.forwardPorts(),
            });
          } else if (cmd.type === "subscribeForwardPorts") {
            const subs = getOrCreatePreviewSubs(ctx);
            subs.get(FORWARD_PORTS_SUB)?.();
            subs.set(
              FORWARD_PORTS_SUB,
              previews.subscribePorts((ports) =>
                ctx.send({ type: "forwardPorts", ports }),
              ),
            );
            ctx.send({
              type: "subscribeForwardPorts.response",
              requestId: cmd.requestId,
            });
          } else if (cmd.type === "unsubscribeForwardPorts") {
            const subs = ctx.state.get(PREVIEW_SUBS_KEY) as
              | PreviewSubs
              | undefined;
            subs?.get(FORWARD_PORTS_SUB)?.();
            subs?.delete(FORWARD_PORTS_SUB);
            ctx.send({
              type: "unsubscribeForwardPorts.response",
              requestId: cmd.requestId,
            });
          } else {
            const outcome = await previews.stop(cmd.directory, cmd.name, {
              by: "user",
            });
            if (outcome.isError) {
              ctx.send({
                type: "error",
                requestId: cmd.requestId,
                code: "not_found",
                message: outcome.text,
              });
            } else {
              ctx.send({
                type: "stopPreview.response",
                requestId: cmd.requestId,
              });
            }
          }
        } catch (err) {
          ctx.send({
            type: "error",
            requestId: cmd.requestId,
            code: "internal",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      default: {
        const requestId =
          "requestId" in cmd
            ? (cmd as { requestId: string }).requestId
            : undefined;
        ctx.send({
          type: "error",
          requestId,
          code: "unsupported",
          message: `command ${(cmd as { type: string }).type} not implemented`,
        });
        return;
      }
    }
  };
}

/**
 * Expand "~" / "~/..." to the daemon machine's HOME, then normalize via
 * `path.resolve` (collapses `..` / `.` segments, ensures absolute).
 * Other shapes (relative paths, "~user") pass through `resolve` as-is,
 * which is enough for iOS — it always sends absolute paths or the
 * literal "~" returned via `getFilesystemRoots`.
 */
function expandHomePath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

/** Map Node `fs` errors to protocol error codes. */
function classifyFsError(
  err: unknown,
  attemptedPath: string,
): { code: "not_found" | "permission_denied" | "internal"; message: string } {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code: string }).code;
    if (code === "ENOENT")
      return { code: "not_found", message: `path not found: ${attemptedPath}` };
    if (code === "EACCES" || code === "EPERM")
      return {
        code: "permission_denied",
        message: `permission denied: ${attemptedPath}`,
      };
  }
  return {
    code: "internal",
    message: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Folders of the most recently updated opencode sessions that still exist
 * on disk, newest first, deduped, at most 10. An unreachable service gives
 * an empty list rather than failing the whole roots call.
 */
async function recentDirectories(
  deps: RouterDeps,
): Promise<{ path: string; lastUsedAt: string }[]> {
  let sessions: RecentSession[];
  try {
    sessions = await deps.recentSessions();
  } catch {
    return [];
  }
  const latest = new Map<string, number>();
  for (const s of sessions) {
    const prev = latest.get(s.directory);
    if (prev === undefined || s.updatedAt > prev) {
      latest.set(s.directory, s.updatedAt);
    }
  }
  const existing = await Promise.all(
    [...latest].map(async ([dir, at]) => {
      const isDir = await fs
        .stat(dir)
        .then((s) => s.isDirectory())
        .catch(() => false);
      return isDir ? { dir, at } : null;
    }),
  );
  return existing
    .filter((e) => e !== null)
    .sort((a, b) => b.at - a.at)
    .slice(0, 10)
    .map((e) => ({ path: e.dir, lastUsedAt: new Date(e.at).toISOString() }));
}
