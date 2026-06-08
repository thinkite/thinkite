import { execFileSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";

/**
 * Result of resolving the Claude Code executable the SDK should spawn.
 * Discriminated on `ok` so callers can show a status / fail a query with a
 * concrete reason.
 */
export type ClaudeStatus =
  | {
      ok: true;
      path: string;
      /** Parsed from `claude --version` (e.g. "2.1.168"); null if the probe failed. */
      version: string | null;
      source: "SIDECODE_CLAUDE_PATH" | "PATH";
    }
  | { ok: false; error: string };

let cached: ClaudeStatus | undefined;

/**
 * Resolve the Claude Code executable, in priority order:
 *   1. SIDECODE_CLAUDE_PATH (explicit override) — errors if set but not executable
 *   2. `claude` on PATH
 *
 * Relies on process.env.PATH / SIDECODE_CLAUDE_PATH already reflecting the
 * user's shell environment. When the daemon runs inside the Finder-launched
 * menubar app, the menubar inherits the shell env BEFORE start() — a GUI app
 * otherwise only gets launchd's minimal PATH. Terminal-launched `sidecode up`
 * already has it.
 *
 * Never throws: returns { ok: false } so the daemon can still start and surface
 * the problem via daemon.claudeStatus(); queries then fail fast with `error`.
 * Cached after the first call — clear with recheckClaudeBinary().
 */
export function resolveClaudeBinary(): ClaudeStatus {
  cached ??= compute();
  return cached;
}

/** Cached status (resolves on first call). */
export function getClaudeStatus(): ClaudeStatus {
  return resolveClaudeBinary();
}

/** Re-run resolution from scratch (e.g. after the user installs Claude Code). */
export function recheckClaudeBinary(): ClaudeStatus {
  cached = compute();
  return cached;
}

function compute(): ClaudeStatus {
  const override = process.env.SIDECODE_CLAUDE_PATH?.trim();
  if (override) {
    // Explicit override: fail loudly rather than silently falling back to PATH,
    // so a typo'd path surfaces instead of masking the user's intent.
    if (!isExecutable(override)) {
      return {
        ok: false,
        error: `SIDECODE_CLAUDE_PATH="${override}" is not an executable file.`,
      };
    }
    return {
      ok: true,
      path: override,
      version: readVersion(override),
      source: "SIDECODE_CLAUDE_PATH",
    };
  }

  const onPath = findOnPath("claude");
  if (!onPath) {
    return {
      ok: false,
      error:
        "Claude Code not found on PATH. Install it (https://claude.ai/install) or set SIDECODE_CLAUDE_PATH.",
    };
  }
  return {
    ok: true,
    path: onPath,
    version: readVersion(onPath),
    source: "PATH",
  };
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Walk process.env.PATH for an executable named `bin` (macOS — ':' separated). */
function findOnPath(bin: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, bin);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

/** "2.1.168 (Claude Code)" → "2.1.168"; null if the probe fails. */
function readVersion(path: string): string | null {
  try {
    const out = execFileSync(path, ["--version"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    return out.split(/\s+/)[0] ?? null;
  } catch {
    return null;
  }
}
