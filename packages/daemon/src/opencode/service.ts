/**
 * Start the user's opencode 2 service when none is running, the way Waku
 * does it (egoist/waku, `crates/waku-core/src/opencode_service.rs`):
 *
 *   - Only when a task starts (a session is created or a prompt sent, see
 *     `startsTask`). Reading the session list never starts it.
 *   - `opencode serve --service`, detached. It short-circuits on a healthy
 *     incumbent, so racing the desktop app or the TUI is safe. Wait for it
 *     to register and answer, at most 20 s.
 *   - Never stop it. A service we started looks exactly like one we found,
 *     and either may be serving the user's terminal. Quitting Thinkite
 *     leaves it running.
 *   - Never write the registry. The service re-reads it every 5 s and
 *     exits when it changes.
 *   - Refuse an opencode 1 binary: its `serve` ignores `--service`, starts
 *     a foreground server that never registers, and would be left orphaned.
 *
 * The binary and the environment the service runs in come from the user's
 * shell (`-i -l -c`, then `-l -c`): an app opened from the Dock sees none
 * of what `~/.zshrc` adds to PATH, and the agent's shell tools and provider
 * keys need that environment too.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import {
  type DiscoveredOpencode,
  discoverOpencode,
  type OpencodeConnection,
  registryPath,
} from "./registry.ts";

/** Resolve the service for a request; `start` lets a missing one be started. */
export type ResolveOpencode = (options?: {
  start?: boolean;
}) => Promise<OpencodeConnection>;

const START_BUDGET_MS = 20_000;
const START_POLL_MS = 100;
const SHELL_TIMEOUT_MS = { interactive: 5_000, login: 3_000 };
const VERSION_TIMEOUT_MS = 5_000;
const ENV_MARKER = "__THINKITE_ENV__";

const TASK_ROUTE =
  /^\/api\/session(?:\/[^/]+\/(?:prompt|command|shell|fork))?$/;

/** Whether an opencode request starts work: creating a session, or a
 *  prompt, command, shell or fork in one. */
export function startsTask(method: string | undefined, url: string): boolean {
  if (method !== "POST") return false;
  return TASK_ROUTE.test(url.split("?", 1)[0] ?? url);
}

/** Run `command` under the user's shell and return its stdout, or null. */
function runInShell(
  shell: string,
  args: readonly string[],
  command: string,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(shell, [...args, command], {
      stdio: ["ignore", "pipe", "ignore"],
      cwd: homedir(),
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
    });
  });
}

/** The user's shell environment; the process's own when it can't be read. */
async function shellEnvironment(): Promise<NodeJS.ProcessEnv> {
  const shell = process.env.SHELL || "/bin/zsh";
  // The marker skips whatever an interactive rc prints first.
  const command = `printf '%s' '${ENV_MARKER}'; command env -0`;
  for (const [args, timeout] of [
    [["-i", "-l", "-c"], SHELL_TIMEOUT_MS.interactive],
    [["-l", "-c"], SHELL_TIMEOUT_MS.login],
  ] as const) {
    const out = await runInShell(shell, args, command, timeout);
    const start = out?.indexOf(ENV_MARKER) ?? -1;
    if (out == null || start < 0) continue;
    const env: NodeJS.ProcessEnv = {};
    for (const entry of out.slice(start + ENV_MARKER.length).split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    if (env.PATH) return env;
  }
  return { ...process.env };
}

async function findExecutable(
  name: string,
  path: string | undefined,
): Promise<string | null> {
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** `binary --version`, or null when it can't be read in time. */
function versionOutput(
  binary: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(binary, ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), VERSION_TIMEOUT_MS);
    child.once("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.once("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
}

/** The major version an `opencode --version` line reports as 1, if it does
 *  (`1.18.30`, `opencode v1.18.30`); betas are `0.0.0-beta-N`. */
export function opencodeOneVersion(output: string): string | null {
  const version = /(\d+)\.\d+\.\d+/.exec(output);
  return version?.[1] === "1" ? version[0] : null;
}

async function startService(path: string): Promise<DiscoveredOpencode> {
  const env = await shellEnvironment();
  // This process's own XDG dirs win (an isolated test run sets them); the
  // registry has to be where this daemon reads it either way.
  for (const key of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
  ] as const) {
    const own = process.env[key];
    if (own !== undefined) env[key] = own;
  }
  if (process.env.XDG_STATE_HOME === undefined) delete env.XDG_STATE_HOME;
  else env.XDG_STATE_HOME = process.env.XDG_STATE_HOME;

  const binary = await findExecutable("opencode", env.PATH);
  if (binary === null) {
    throw new Error(
      "opencode is not installed — install OpenCode 2 (`npm install -g @opencode/cli`) or open the OpenCode app",
    );
  }
  const version = await versionOutput(binary, env);
  const one = version === null ? null : opencodeOneVersion(version);
  if (one !== null) {
    throw new Error(
      `Thinkite needs OpenCode 2, but ${binary} is OpenCode ${one} — install OpenCode 2 (\`npm install -g @opencode/cli\`)`,
    );
  }

  const child = spawn(binary, ["serve", "--service"], {
    detached: true,
    stdio: "ignore",
    env,
    cwd: homedir(),
  });
  let exit: number | string | null | undefined;
  let spawnError: Error | undefined;
  child.once("error", (err) => {
    spawnError = err;
  });
  child.once("exit", (code, signal) => {
    exit = code ?? signal;
  });
  child.unref();

  const deadline = Date.now() + START_BUDGET_MS;
  while (true) {
    const found = await discoverOpencode(path);
    if (found !== null) return found;
    if (spawnError !== undefined) {
      throw new Error(`failed to start opencode: ${spawnError.message}`);
    }
    // An exit is not fatal by itself: losing the race to another starter
    // looks the same, and the winner may be seconds from healthy.
    if (Date.now() >= deadline) {
      throw new Error(
        exit === undefined
          ? "timed out starting the opencode background service"
          : `\`opencode serve --service\` exited (${exit}) without registering a healthy service`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
  }
}

/** One start at a time: concurrent task requests share it. */
export function createOpencodeStarter(
  options: { path?: string; log?: (message: string) => void } = {},
) {
  const path = options.path ?? registryPath();
  let inflight: Promise<DiscoveredOpencode> | null = null;
  return {
    start(): Promise<DiscoveredOpencode> {
      if (inflight === null) {
        options.log?.("starting the opencode background service");
        inflight = startService(path).finally(() => {
          inflight = null;
        });
      }
      return inflight;
    },
  };
}
