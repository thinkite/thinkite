/**
 * Start the user's opencode 2 service when none is running, through
 * `@opencode/client`'s `Service.ensure` — what the OpenCode desktop app and
 * the TUI use — on Waku's terms (egoist/waku, `opencode_service.rs`):
 *
 *   - When the desktop app opens (it asks right after the daemon is up, as
 *     the OpenCode desktop app does), and again when a task starts (a
 *     session is created or a prompt sent, see `startsTask`) with none
 *     running. Requests that arrive while a start is under way wait for it.
 *   - Any running version is reused. The official clients pin their own
 *     version and replace a service that differs; we accept whatever is
 *     registered, so starting a task never swaps the user's service. (The
 *     one stop left is ensure's own recovery: a registered service that
 *     misses three probes in a row is restarted, as the official clients
 *     do too.)
 *   - Quitting Thinkite leaves the service running, and the registry is
 *     only ever written by opencode itself.
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
import { Service } from "@opencode/client/service";
import { type OpencodeConnection, registryPath } from "./registry.ts";

/** Resolve the service for a request; `start` lets a missing one be started. */
export type ResolveOpencode = (options?: {
  start?: boolean;
}) => Promise<OpencodeConnection>;

// A heavy ~/.zshrc measured 2–4 s on an idle Mac, and more while the app
// itself is starting; past the interactive budget the login-only fallback
// misses whatever .zshrc adds to PATH.
const SHELL_TIMEOUT_MS = { interactive: 10_000, login: 3_000 };
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
    // Give up at the deadline itself: something the rc started in the
    // background can keep the pipe, and so "close", open long after.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve(null);
    }, timeoutMs);
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

/** The user's shell environment, read once; the process's own when it
 *  can't be read (and then read again next time). */
let cachedShellEnv: Promise<NodeJS.ProcessEnv | null> | null = null;
async function shellEnvironment(): Promise<NodeJS.ProcessEnv> {
  cachedShellEnv ??= readShellEnvironment();
  const env = await cachedShellEnv;
  if (env === null) cachedShellEnv = null;
  return { ...(env ?? process.env) };
}

async function readShellEnvironment(): Promise<NodeJS.ProcessEnv | null> {
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
  return null;
}

/** Where opencode installs itself when it isn't on the PATH read: its
 *  install script, bun, Homebrew, npm prefixes, then the CLI the OpenCode
 *  desktop app bundles. */
const FALLBACK_LOCATIONS = [
  join(homedir(), ".opencode", "bin", "opencode"),
  join(homedir(), ".bun", "bin", "opencode"),
  "/opt/homebrew/bin/opencode",
  "/usr/local/bin/opencode",
  join(homedir(), ".npm-global", "bin", "opencode"),
  join(homedir(), ".local", "bin", "opencode"),
  "/Applications/OpenCode.app/Contents/Resources/opencode-cli",
];

async function findOpencode(path: string | undefined): Promise<string | null> {
  const onPath = await findExecutable("opencode", path);
  if (onPath !== null) return onPath;
  for (const candidate of FALLBACK_LOCATIONS) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
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

/** The opencode 2 binary and the environment to run it in: the user's
 *  shell's, with this process's XDG dirs. Throws when opencode is missing
 *  or is opencode 1. */
export async function opencodeCommand(): Promise<{
  binary: string;
  env: Record<string, string>;
}> {
  const env = await shellEnvironment();
  // This process's own XDG dirs win (an isolated test run sets them); the
  // registry has to be where this daemon reads it either way. `env` is laid
  // over this process's environment, so a key left out is inherited.
  for (const key of [
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
  ] as const) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (process.env.XDG_STATE_HOME === undefined) delete env.XDG_STATE_HOME;

  const binary = await findOpencode(env.PATH);
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

  const overlay: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) overlay[key] = value;
  }
  return { binary, env: overlay };
}

async function startService(path: string): Promise<void> {
  const { binary, env } = await opencodeCommand();
  await Service.ensure({
    file: path,
    version: () => true,
    command: [binary, "serve", "--service"],
    env,
  });
}

/** One start at a time: concurrent task requests share it. */
export function createOpencodeStarter(
  options: { path?: string; log?: (message: string) => void } = {},
) {
  const path = options.path ?? registryPath();
  let inflight: Promise<void> | null = null;
  return {
    /** The start under way, if any: other requests wait on it. */
    pending(): Promise<void> | null {
      return inflight;
    },
    start(): Promise<void> {
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
