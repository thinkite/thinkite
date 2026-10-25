// `preview_start` without a command: the configuration of that name in the
// project's `.claude/launch.json`, the file Claude Code's own preview reads
// (`{ configurations: [{ name, runtimeExecutable, runtimeArgs, cwd?, env? }] }`).
// Its `port` is not used: the registry finds the ports the process opens.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface LaunchCommand {
  command: string;
  cwd?: string;
}

interface Configuration {
  name?: unknown;
  runtimeExecutable?: unknown;
  runtimeArgs?: unknown;
  cwd?: unknown;
  env?: unknown;
}

const SAFE = /^[\w@%+=:,./-]+$/;

export function shellQuote(word: string): string {
  return SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/** The named configuration as a shell command, or an error message. */
export async function launchCommand(
  directory: string,
  name: string,
): Promise<LaunchCommand | { error: string }> {
  const file = join(directory, ".claude", "launch.json");
  let configurations: Configuration[];
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      configurations?: unknown;
    };
    configurations = Array.isArray(parsed.configurations)
      ? parsed.configurations
      : [];
  } catch {
    return {
      error: `no command given and no .claude/launch.json in this project; pass command`,
    };
  }
  const config = configurations.find((c) => c.name === name);
  if (!config || typeof config.runtimeExecutable !== "string") {
    return {
      error: `.claude/launch.json has no configuration named "${name}"; pass command`,
    };
  }
  const args = Array.isArray(config.runtimeArgs)
    ? config.runtimeArgs.filter((a): a is string => typeof a === "string")
    : [];
  const env =
    config.env !== null && typeof config.env === "object"
      ? Object.entries(config.env as Record<string, unknown>)
          .filter(
            ([key, value]) =>
              /^[A-Za-z_]\w*$/.test(key) && typeof value === "string",
          )
          .map(([key, value]) => `${key}=${shellQuote(value as string)}`)
      : [];
  return {
    command: [
      ...env,
      ...[config.runtimeExecutable, ...args].map(shellQuote),
    ].join(" "),
    ...(typeof config.cwd === "string" ? { cwd: config.cwd } : {}),
  };
}
