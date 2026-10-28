/**
 * Install and uninstall opencode plugins the way the user would, with
 * `opencode plugin add|remove`: the server has routes to list, check and
 * update plugins, but none to install or remove one (2.2). The CLI
 * installs the package and edits the `plugins` list in the global
 * opencode.json, and the running service reloads on its own when that file
 * changes, so nothing here talks to the service.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { opencodeCommand } from "./service.ts";

// An npm install measured ~11 s; a slow registry or a git clone takes more.
const TIMEOUT_MS = 180_000;

/** Whether `spec` can be handed to the CLI as a package: non-empty, one
 *  argument, and never read as a flag. */
export function isPluginSpec(spec: string): boolean {
  return (
    spec.length > 0 &&
    spec.length <= 512 &&
    !spec.startsWith("-") &&
    !/\s/.test(spec)
  );
}

/**
 * The line worth showing from a failed CLI run's stderr: the error's own
 * message, else its cause's (an npm 404 has an empty message and a
 * `[cause]: …: 404 Not Found - GET … - Not found`), else the first line.
 */
export function summarizeCliError(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("at "));
  for (const line of lines) {
    const message = /^[A-Za-z_$][\w$]*: (.+)$/.exec(line)?.[1];
    if (message !== undefined && !line.startsWith("[cause]")) return message;
  }
  const cause = lines.find((line) => line.startsWith("[cause]:"));
  if (cause !== undefined) {
    if (/\b404 Not Found\b/.test(cause)) return "No such package on npm";
    return cause
      .replace(/^\[cause\]:\s*/, "")
      .replace(/^[A-Za-z_$][\w$]*: /, "");
  }
  return lines[0] ?? "opencode exited with an error";
}

/** Run `opencode plugin <action> <spec>`; rejects with the CLI's error. */
export async function runPluginCommand(
  action: "add" | "remove",
  spec: string,
): Promise<void> {
  if (!isPluginSpec(spec)) throw new Error("Enter an npm package or Git URL");
  const { binary, env } = await opencodeCommand();
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, ["plugin", action, spec], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: homedir(),
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else if (signal === "SIGKILL") reject(new Error("opencode timed out"));
      else reject(new Error(summarizeCliError(stderr)));
    });
  });
  // `remove` edits only the global config and succeeds when the plugin
  // isn't there, as for one a project's opencode.json loads.
  if (action === "remove" && stdout.includes("is not configured")) {
    throw new Error(
      `${spec} isn't in your global opencode.json; remove it from the project's opencode.json that loads it`,
    );
  }
}
