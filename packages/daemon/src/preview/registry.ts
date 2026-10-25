// The daemon's list of servers the agent started with the preview tools,
// per project directory (docs/preview-tool-v1.md).
//
// opencode's shells are the source of truth and this is a cache that can
// always be rebuilt: every shell we create carries
// `metadata.thinkite = { preview, open, session }`, so after a daemon
// restart `rebuild` finds the running ones again. What a rebuild loses is
// what only lived here: sessions that reused a server after its starter,
// a later request to open it (the stamp falls back to the start), and the
// entries of servers that had already ended.

import { resolve as resolvePath } from "node:path";
import type { PreviewEntry } from "@thinkite/protocol";
import { listeningPorts, probeHttp } from "./ports.ts";
import type { ShellApi, ShellInfo, ShellStatus } from "./shells.ts";

export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

export interface StartInput {
  name: string;
  command?: string;
  cwd?: string;
  open?: boolean;
}

export interface RegistryOptions {
  shells: ShellApi;
  ports?: (pid: number) => Promise<number[]>;
  probe?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  /** How long `start` waits for a port before answering. */
  waitMs?: number;
  /** How much longer detection keeps going after `start` gave up. */
  backgroundMs?: number;
  pollMs?: number;
  log?: (message: string) => void;
}

interface Entry {
  directory: string;
  name: string;
  shellID: string;
  pid?: number;
  command: string;
  cwd?: string;
  ports: number[];
  primaryPort?: number;
  status: PreviewEntry["status"];
  opened?: { at: number; sessionID: string };
  sessions: string[];
  startedAt: number;
  exit?: number;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes start with ESC
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const LOG_BYTES = 32 * 1024;

export class PreviewRegistry {
  private readonly shells: ShellApi;
  private readonly ports: (pid: number) => Promise<number[]>;
  private readonly probe: (port: number) => Promise<boolean>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly waitMs: number;
  private readonly backgroundMs: number;
  private readonly pollMs: number;
  private readonly log: (message: string) => void;

  private readonly dirs = new Map<string, Map<string, Entry>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<
    string,
    Set<(entries: PreviewEntry[]) => void>
  >();

  constructor(options: RegistryOptions) {
    this.shells = options.shells;
    this.ports = options.ports ?? listeningPorts;
    this.probe = options.probe ?? probeHttp;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.waitMs = options.waitMs ?? 30_000;
    this.backgroundMs = options.backgroundMs ?? 120_000;
    this.pollMs = options.pollMs ?? 250;
    this.log = options.log ?? (() => undefined);
  }

  // ─── Tools ──────────────────────────────────────────────────────────────

  start(
    directory: string,
    input: StartInput,
    sessionID?: string,
  ): Promise<ToolOutcome> {
    return this.locked(`${directory}\0${input.name}`, () =>
      this.startLocked(directory, input, sessionID),
    );
  }

  async list(
    directory: string,
    sessionID?: string,
    all = false,
  ): Promise<ToolOutcome> {
    const entries = await this.refreshAll(directory);
    const mine =
      all || sessionID === undefined
        ? entries
        : entries.filter((e) => e.sessions.includes(sessionID));
    const hidden = entries.length - mine.length;
    const lines = mine.map((e) => `${e.name}: ${describe(e)}`);
    if (lines.length === 0)
      lines.push(
        all
          ? "No servers in this project."
          : "No servers started in this session.",
      );
    if (hidden > 0)
      lines.push(`${hidden} more in this project (pass all: true).`);
    return { text: lines.join("\n") };
  }

  async logs(
    directory: string,
    name: string,
    lines = 40,
  ): Promise<ToolOutcome> {
    const entry = this.dir(directory).get(name);
    if (!entry)
      return {
        text: `No server named "${name}". Call preview_list.`,
        isError: true,
      };
    const text = await this.tail(entry, Math.min(Math.max(1, lines), 200));
    return { text: text || "(no output yet)" };
  }

  async stop(
    directory: string,
    name: string,
    sessionID?: string,
  ): Promise<ToolOutcome> {
    return this.locked(`${directory}\0${name}`, async () => {
      const entry = this.dir(directory).get(name);
      if (!entry)
        return {
          text: `No server named "${name}". Call preview_list.`,
          isError: true,
        };
      if (entry.status !== "running" && entry.status !== "starting")
        return { text: `"${name}" is not running (${entry.status}).` };
      await this.shells.remove(directory, entry.shellID).catch(() => undefined);
      if (entry.pid !== undefined) {
        for (let i = 0; i < 12 && (await this.ports(entry.pid)).length > 0; i++)
          await this.sleep(250);
      }
      // Kept as ended, not dropped: its logs stay readable and clients can
      // show it stopped. A later start of the name replaces it.
      this.markEnded(entry, "killed");
      this.notify(directory);
      const others = entry.sessions.filter((s) => s !== sessionID);
      return {
        text:
          `Stopped "${name}".` +
          (others.length > 0
            ? ` It was also in use by ${others.length} other session(s); it stopped for them too.`
            : ""),
      };
    });
  }

  // ─── Clients ────────────────────────────────────────────────────────────

  /** The directory's entries, re-checked against the shells. */
  async entries(directory: string): Promise<PreviewEntry[]> {
    return (await this.refreshAll(directory)).map(toPublic);
  }

  subscribe(
    directory: string,
    listener: (entries: PreviewEntry[]) => void,
  ): () => void {
    let set = this.listeners.get(directory);
    if (!set) {
      set = new Set();
      this.listeners.set(directory, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  // ─── opencode side ──────────────────────────────────────────────────────

  /** Recover entries from the directory's running shells (after a daemon
   *  restart or an opencode reconnect) and drop the ones whose shell is gone. */
  async rebuild(directory: string): Promise<void> {
    const running = await this.shells.list(directory);
    const dir = this.dir(directory);
    const byShell = new Map(running.map((s) => [s.id, s]));
    for (const entry of dir.values()) {
      if (
        (entry.status === "running" || entry.status === "starting") &&
        !byShell.has(entry.shellID)
      ) {
        const info = await this.shells.get(directory, entry.shellID);
        this.markEnded(entry, info?.status ?? "killed", info?.exit);
      }
    }
    for (const shell of running) {
      const meta = previewMeta(shell);
      if (!meta) continue;
      const current = dir.get(meta.preview);
      if (current?.shellID === shell.id) continue;
      const entry: Entry = {
        directory,
        name: meta.preview,
        shellID: shell.id,
        pid: shell.pid,
        command: shell.command,
        cwd: shell.cwd,
        ports: [],
        status: "starting",
        ...(meta.open && meta.session
          ? { opened: { at: shell.time.started, sessionID: meta.session } }
          : {}),
        sessions: meta.session ? [meta.session] : [],
        startedAt: shell.time.started,
      };
      dir.set(entry.name, entry);
      this.log(`preview rebuilt ${entry.name} (${shell.id}) in ${directory}`);
      void this.detectInBackground(entry, this.backgroundMs);
    }
    this.notify(directory);
  }

  /** opencode's `shell.exited` event. */
  shellExited(shellID: string, status: ShellStatus, exit?: number): void {
    for (const [directory, dir] of this.dirs) {
      for (const entry of dir.values()) {
        if (entry.shellID !== shellID) continue;
        this.markEnded(entry, status, exit);
        this.notify(directory);
        return;
      }
    }
  }

  directories(): string[] {
    return [...this.dirs.keys()];
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async startLocked(
    directory: string,
    input: StartInput,
    sessionID?: string,
  ): Promise<ToolOutcome> {
    const dir = this.dir(directory);
    const existing = dir.get(input.name);
    if (
      existing &&
      (existing.status === "running" || existing.status === "starting")
    ) {
      await this.refresh(existing);
    }
    const command = input.command?.trim() || undefined;
    const cwd = input.cwd;
    if (
      existing &&
      (existing.status === "running" || existing.status === "starting")
    ) {
      if (command !== undefined && command !== existing.command) {
        return {
          text: `"${input.name}" is already running \`${existing.command}\`; call preview_stop first to change it.`,
          isError: true,
        };
      }
      if (sessionID && !existing.sessions.includes(sessionID))
        existing.sessions.push(sessionID);
      if (input.open && sessionID)
        existing.opened = { at: Date.now(), sessionID };
      this.notify(directory);
      return {
        text: `"${input.name}" is already ${describeRunning(existing)}`,
      };
    }
    if (command === undefined) {
      return { text: "command is required to start a server.", isError: true };
    }
    const absoluteCwd =
      cwd === undefined ? undefined : resolvePath(directory, cwd);
    const open = input.open === true;
    const shell = await this.shells.create(directory, {
      command,
      ...(absoluteCwd === undefined ? {} : { cwd: absoluteCwd }),
      metadata: {
        thinkite: { preview: input.name, open, session: sessionID ?? null },
      },
    });
    const startedAt = shell.time?.started ?? Date.now();
    const entry: Entry = {
      directory,
      name: input.name,
      shellID: shell.id,
      pid: shell.pid,
      command,
      cwd: absoluteCwd,
      ports: [],
      status: "starting",
      ...(open && sessionID ? { opened: { at: Date.now(), sessionID } } : {}),
      sessions: sessionID ? [sessionID] : [],
      startedAt,
    };
    dir.set(entry.name, entry);
    this.log(
      `preview start ${entry.name} (${shell.id}) in ${directory}: ${command}`,
    );
    this.notify(directory);

    const outcome = await this.detect(entry, this.waitMs);
    if (outcome === "listening") {
      return { text: `"${entry.name}" is ${describeRunning(entry)}` };
    }
    if (outcome === "ended") {
      const tail = await this.tail(entry, 40);
      return {
        text:
          `"${entry.name}" ${entry.status === "exited" ? `exited (code ${entry.exit ?? "?"})` : entry.status} before listening on a port.` +
          (tail ? `\nLast output:\n${tail}` : ""),
        isError: true,
      };
    }
    void this.detectInBackground(entry, this.backgroundMs);
    return {
      text: `"${entry.name}" is running but no port is listening after ${Math.round(this.waitMs / 1000)} s. Check preview_logs.`,
      isError: true,
    };
  }

  /** Poll until the shell listens on a port, ends, or `budgetMs` passes. */
  private async detect(
    entry: Entry,
    budgetMs: number,
  ): Promise<"listening" | "ended" | "waiting"> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
      const info = await this.shells.get(entry.directory, entry.shellID);
      if (info?.status !== "running") {
        this.markEnded(entry, info?.status ?? "killed", info?.exit);
        this.notify(entry.directory);
        return "ended";
      }
      entry.pid ??= info.pid;
      if (entry.pid !== undefined) {
        const ports = await this.ports(entry.pid);
        if (ports.length > 0) {
          await this.settle(entry, ports);
          this.notify(entry.directory);
          return "listening";
        }
      }
      if (Date.now() >= deadline) return "waiting";
      await this.sleep(this.pollMs);
    }
  }

  private async detectInBackground(
    entry: Entry,
    budgetMs: number,
  ): Promise<void> {
    try {
      const outcome = await this.detect(entry, budgetMs);
      if (outcome === "waiting") {
        entry.status = "running";
        this.notify(entry.directory);
      }
    } catch (err) {
      this.log(
        `preview detect ${entry.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async settle(entry: Entry, ports: number[]): Promise<void> {
    entry.ports = ports;
    entry.status = "running";
    // The page's URL: the first port that answers HTTP, so a debugger or
    // other side port of the same process tree isn't the one opened.
    for (const port of ports) {
      if (await this.probe(port)) {
        entry.primaryPort = port;
        return;
      }
    }
    entry.primaryPort = ports[0];
  }

  /** Re-check one entry's shell and ports. */
  private async refresh(entry: Entry): Promise<void> {
    if (entry.status !== "running" && entry.status !== "starting") return;
    const info = await this.shells.get(entry.directory, entry.shellID);
    if (info?.status !== "running") {
      this.markEnded(entry, info?.status ?? "killed", info?.exit);
      return;
    }
    if (entry.pid === undefined) entry.pid = info.pid;
    if (entry.pid === undefined) return;
    const ports = await this.ports(entry.pid);
    if (ports.length > 0 && ports.join() !== entry.ports.join())
      await this.settle(entry, ports);
    else entry.ports = ports;
  }

  private async refreshAll(directory: string): Promise<Entry[]> {
    const entries = [...this.dir(directory).values()];
    const before = JSON.stringify(entries.map(toPublic));
    await Promise.all(
      entries.map((e) => this.refresh(e).catch(() => undefined)),
    );
    if (JSON.stringify(entries.map(toPublic)) !== before)
      this.notify(directory);
    return entries;
  }

  private markEnded(entry: Entry, status: ShellStatus, exit?: number): void {
    entry.status = status === "running" ? "killed" : status;
    entry.ports = [];
    if (exit !== undefined) entry.exit = exit;
  }

  private async tail(entry: Entry, lines: number): Promise<string> {
    const text = await this.shells
      .tail(entry.directory, entry.shellID, LOG_BYTES)
      .catch(() => "");
    return text
      .replace(ANSI, "")
      .replace(/\r/g, "")
      .trimEnd()
      .split("\n")
      .slice(-lines)
      .join("\n");
  }

  private notify(directory: string): void {
    const listeners = this.listeners.get(directory);
    if (!listeners || listeners.size === 0) return;
    const entries = [...this.dir(directory).values()].map(toPublic);
    for (const listener of listeners) listener(entries);
  }

  private dir(directory: string): Map<string, Entry> {
    let dir = this.dirs.get(directory);
    if (!dir) {
      dir = new Map();
      this.dirs.set(directory, dir);
    }
    return dir;
  }

  private locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.locks.set(key, tail);
    void tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return next;
  }
}

function previewMeta(
  shell: ShellInfo,
): { preview: string; open: boolean; session?: string } | null {
  const meta = shell.metadata?.thinkite as Record<string, unknown> | undefined;
  if (!meta || typeof meta.preview !== "string") return null;
  return {
    preview: meta.preview,
    open: meta.open === true,
    ...(typeof meta.session === "string" ? { session: meta.session } : {}),
  };
}

function toPublic(entry: Entry): PreviewEntry {
  return {
    name: entry.name,
    ports: entry.ports,
    ...(entry.primaryPort === undefined
      ? {}
      : { primaryPort: entry.primaryPort }),
    status: entry.status,
    ...(entry.opened === undefined ? {} : { opened: entry.opened }),
    command: entry.command,
    sessions: entry.sessions,
    startedAt: entry.startedAt,
    ...(entry.exit === undefined ? {} : { exit: entry.exit }),
  };
}

function url(entry: Entry): string {
  return `http://localhost:${entry.primaryPort ?? entry.ports[0]}`;
}

/** "running at http://localhost:5180 (also listening on 24678). Sent to…" */
function describeRunning(entry: Entry): string {
  if (entry.status === "starting" || entry.ports.length === 0) {
    return "running, but no port is listening yet. Check preview_logs.";
  }
  const others = entry.ports.filter((p) => p !== entry.primaryPort);
  return (
    `running at ${url(entry)}` +
    (others.length > 0 ? ` (also listening on ${others.join(", ")})` : "") +
    (entry.opened
      ? ". Sent to the user's preview pane."
      : ". Registered (not opened).")
  );
}

/** One `preview_list` line after the name. */
function describe(entry: Entry): string {
  switch (entry.status) {
    case "starting":
      return `starting, no port yet — \`${entry.command}\``;
    case "running":
      if (entry.ports.length === 0)
        return `running (no port listening) — \`${entry.command}\``;
      return (
        `${url(entry)} — running` +
        (entry.opened ? ", shown to the user" : "") +
        (entry.ports.length > 1 ? `, ports ${entry.ports.join(", ")}` : "") +
        ` — \`${entry.command}\``
      );
    case "exited":
      return `exited (code ${entry.exit ?? "?"}) — \`${entry.command}\``;
    default:
      return `${entry.status} — \`${entry.command}\``;
  }
}
