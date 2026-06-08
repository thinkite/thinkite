import { execFile } from "node:child_process";

// Markers bracket the `env` output so we can isolate it from anything the
// user's rc files print to stdout (banners, "you have mail", etc.).
const DELIM = "_SIDECODE_SHELL_ENV_DELIM_";

/**
 * GUI apps launched from Finder/Dock/launchd inherit launchd's MINIMAL
 * environment — not the user's shell config. So `process.env.PATH` lacks
 * ~/.local/bin, Homebrew, etc., and anything set in ~/.zshrc / ~/.zprofile
 * (e.g. SIDECODE_CLAUDE_PATH) is invisible. The in-process daemon then can't
 * resolve `claude`, and tools we spawn get a crippled PATH.
 *
 * Fix it the standard Electron way: run the user's LOGIN + INTERACTIVE shell
 * once, capture its environment, and merge it into process.env BEFORE starting
 * the daemon. macOS only; best-effort — never throws, degrades to the current
 * env (the daemon then fails loud via claudeStatus() if claude stays unresolved).
 *
 * PATH is replaced with the shell's (the complete user PATH). Other keys only
 * fill gaps (`??=`) so we don't clobber vars Electron/launchd set for us.
 */
export async function inheritShellEnv(): Promise<void> {
  if (process.platform !== "darwin") return;
  const shell = process.env.SHELL || "/bin/zsh";
  let env: Record<string, string> | null = null;
  try {
    env = await captureShellEnv(shell);
  } catch (err) {
    console.warn(
      `[main] shell-env inherit failed (${err instanceof Error ? err.message : err}); using launch env`,
    );
    return;
  }
  for (const [key, value] of Object.entries(env)) {
    if (key === "PATH") process.env.PATH = value;
    else process.env[key] ??= value;
  }
}

function captureShellEnv(shell: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    // -l (login) sources .zprofile/.zlogin, -i (interactive) sources .zshrc,
    // -c runs the command. Covers wherever the user sets PATH. The shell may
    // emit noise to stdout from rc files; the DELIM markers fence the env block.
    const command = `echo ${DELIM}; env; echo ${DELIM}`;
    execFile(
      shell,
      ["-ilc", command],
      { timeout: 5000, maxBuffer: 1024 * 1024, encoding: "utf8" },
      (err, stdout) => {
        // A nonzero exit can still produce usable stdout (rc warnings); only
        // bail if we got nothing.
        if (err && !stdout) return reject(err);
        const parts = stdout.split(DELIM);
        const body = parts.length >= 3 ? parts[1] : stdout;
        const out: Record<string, string> = {};
        for (const line of body.split("\n")) {
          const eq = line.indexOf("=");
          if (eq <= 0) continue;
          out[line.slice(0, eq)] = line.slice(eq + 1);
        }
        resolve(out);
      },
    );
  });
}
