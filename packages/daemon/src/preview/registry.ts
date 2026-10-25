// The daemon's list of servers the agent showed with `preview_open`, per
// project directory (docs/preview-tool-v1.md).
//
// The agent starts a server itself, with the shell tool's background mode,
// and registers it by name, shell ID and URL. opencode's shell says whether
// it still runs; the rest (name, URL, the request to show it, sessions)
// only exists here, so it is kept in a small file in the Thinkite home and
// read back when the daemon starts.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import type { PreviewEntry } from "@thinkite/protocol";
import { listeningPorts } from "./ports.ts";
import type { ShellApi, ShellStatus } from "./shells.ts";

export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

export interface OpenInput {
  name: string;
  shellID: string;
  url: string;
  /** Default true. */
  open?: boolean;
}

export interface RegistryOptions {
  shells: ShellApi;
  ports?: (pid: number) => Promise<number[]>;
  sleep?: (ms: number) => Promise<void>;
  /** Where entries persist across daemon restarts. Absent: memory only. */
  stateFile?: string;
  log?: (message: string) => void;
}

interface Entry {
  directory: string;
  name: string;
  shellID: string;
  pid?: number;
  command: string;
  url: string;
  /** The URL's port when the URL is on this machine (and so was checked). */
  localPort?: number;
  status: PreviewEntry["status"];
  opened?: { at: number; sessionID: string };
  sessions: string[];
  startedAt: number;
  exit?: number;
}

interface StateFile {
  v: 1;
  entries: Entry[];
}

export class PreviewRegistry {
  private readonly shells: ShellApi;
  private readonly ports: (pid: number) => Promise<number[]>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly stateFile?: string;
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
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.stateFile = options.stateFile;
    this.log = options.log ?? (() => undefined);
    this.load();
  }

  // ─── Tools ──────────────────────────────────────────────────────────────

  open(
    directory: string,
    input: OpenInput,
    sessionID?: string,
  ): Promise<ToolOutcome> {
    return this.locked(`${directory}\0${input.name}`, () =>
      this.openLocked(directory, input, sessionID),
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
          : "No servers registered in this session.",
      );
    if (hidden > 0)
      lines.push(`${hidden} more in this project (pass all: true).`);
    return { text: lines.join("\n") };
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
      if (entry.status !== "running")
        return { text: `"${name}" is not running (${entry.status}).` };
      await this.shells.remove(directory, entry.shellID).catch(() => undefined);
      if (entry.pid !== undefined && entry.localPort !== undefined) {
        for (let i = 0; i < 12 && (await this.ports(entry.pid)).length > 0; i++)
          await this.sleep(250);
      }
      // Kept as ended, not dropped: clients show it stopped. A later
      // preview_open of the name replaces it.
      this.markEnded(entry, "killed");
      this.changed(directory);
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

  /** Re-check the directory's entries against their shells: after a daemon
   *  restart or an opencode reconnect, `shell.exited` may have been missed. */
  async rebuild(directory: string): Promise<void> {
    await this.refreshAll(directory);
  }

  /** opencode's `shell.exited` event. */
  shellExited(shellID: string, status: ShellStatus, exit?: number): void {
    for (const [directory, dir] of this.dirs) {
      for (const entry of dir.values()) {
        if (entry.shellID !== shellID || entry.status !== "running") continue;
        this.markEnded(entry, status, exit);
        this.changed(directory);
        return;
      }
    }
  }

  directories(): string[] {
    return [...this.dirs.keys()];
  }

  // ─── Internals ──────────────────────────────────────────────────────────

  private async openLocked(
    directory: string,
    input: OpenInput,
    sessionID?: string,
  ): Promise<ToolOutcome> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return { text: `Not a URL: ${input.url}`, isError: true };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return { text: "The URL must be http or https.", isError: true };

    const dir = this.dir(directory);
    const existing = dir.get(input.name);
    if (existing?.status === "running") await this.refresh(existing);
    const same = existing?.shellID === input.shellID ? existing : undefined;
    if (existing?.status === "running" && same === undefined) {
      return {
        text: `"${input.name}" is shell ${existing.shellID}, still running; call preview_stop first or use another name.`,
        isError: true,
      };
    }

    const shell = await this.shells.get(directory, input.shellID);
    if (!shell)
      return {
        text: `No shell ${input.shellID} in this project. Pass the shell ID the shell tool returned for the background command.`,
        isError: true,
      };
    if (shell.status !== "running")
      return {
        text: `Shell ${input.shellID} is not running (${shell.status}${shell.exit === undefined ? "" : `, code ${shell.exit}`}). Check its output.`,
        isError: true,
      };

    // The one fact checked: a URL on this machine is served by this shell's
    // processes. Others (a tunnel, a public host) are taken as given.
    let localPort: number | undefined;
    if (isThisMachine(url.hostname)) {
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      const listening =
        shell.pid === undefined ? [] : await this.ports(shell.pid);
      if (!listening.includes(port))
        return {
          text:
            `Shell ${input.shellID} is not listening on ${port}` +
            (listening.length > 0
              ? ` (it listens on ${listening.join(", ")}).`
              : " yet. Wait until its output shows the server is ready.") +
            " Nothing was opened.",
          isError: true,
        };
      localPort = port;
    }

    const open = input.open !== false;
    const sessions = same?.sessions ?? [];
    if (sessionID && !sessions.includes(sessionID)) sessions.push(sessionID);
    const opened =
      open && sessionID ? { at: Date.now(), sessionID } : same?.opened;
    const entry: Entry = {
      directory,
      name: input.name,
      shellID: shell.id,
      ...(shell.pid === undefined ? {} : { pid: shell.pid }),
      command: shell.command,
      url: url.href,
      ...(localPort === undefined ? {} : { localPort }),
      status: "running",
      ...(opened === undefined ? {} : { opened }),
      sessions,
      startedAt: shell.time.started,
    };
    dir.set(entry.name, entry);
    this.log(
      `preview open ${entry.name} (${shell.id}) in ${directory}: ${entry.url}`,
    );
    this.changed(directory);
    return {
      text:
        `Registered "${entry.name}" at ${entry.url}` +
        (!open
          ? " (not opened)."
          : sessionID
            ? ". Sent to the user's browser."
            : " (no session to show it in)."),
    };
  }

  /** Re-check one entry's shell. */
  private async refresh(entry: Entry): Promise<void> {
    if (entry.status !== "running") return;
    const info = await this.shells.get(entry.directory, entry.shellID);
    if (info?.status !== "running")
      this.markEnded(entry, info?.status ?? "killed", info?.exit);
  }

  private async refreshAll(directory: string): Promise<Entry[]> {
    const entries = [...this.dir(directory).values()];
    const before = JSON.stringify(entries.map(toPublic));
    await Promise.all(
      entries.map((e) => this.refresh(e).catch(() => undefined)),
    );
    if (JSON.stringify(entries.map(toPublic)) !== before)
      this.changed(directory);
    return entries;
  }

  private markEnded(entry: Entry, status: ShellStatus, exit?: number): void {
    entry.status = status === "running" ? "killed" : status;
    if (exit !== undefined) entry.exit = exit;
  }

  /** Persist, then push to the directory's clients. */
  private changed(directory: string): void {
    this.save();
    const listeners = this.listeners.get(directory);
    if (!listeners || listeners.size === 0) return;
    const entries = [...this.dir(directory).values()].map(toPublic);
    for (const listener of listeners) listener(entries);
  }

  /** Running entries come back and `rebuild` re-checks them; ones that had
   *  already ended are left behind. */
  private load(): void {
    if (this.stateFile === undefined) return;
    let state: StateFile;
    try {
      state = JSON.parse(readFileSync(this.stateFile, "utf8")) as StateFile;
    } catch {
      return;
    }
    if (state.v !== 1 || !Array.isArray(state.entries)) return;
    for (const entry of state.entries)
      if (entry.status === "running")
        this.dir(entry.directory).set(entry.name, entry);
  }

  private save(): void {
    if (this.stateFile === undefined) return;
    const state: StateFile = {
      v: 1,
      entries: [...this.dirs.values()].flatMap((d) => [...d.values()]),
    };
    try {
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
      });
      renameSync(tmp, this.stateFile);
    } catch (err) {
      this.log(
        `preview save: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
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

/** Loopback, `*.localhost`, or one of this machine's interface addresses. */
export function isThisMachine(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    host.startsWith("127.")
  )
    return true;
  return Object.values(networkInterfaces()).some((list) =>
    list?.some((i) => i.address.toLowerCase() === host),
  );
}

function toPublic(entry: Entry): PreviewEntry {
  return {
    name: entry.name,
    url: entry.url,
    status: entry.status,
    ...(entry.opened === undefined ? {} : { opened: entry.opened }),
    command: entry.command,
    sessions: entry.sessions,
    startedAt: entry.startedAt,
    ...(entry.exit === undefined ? {} : { exit: entry.exit }),
  };
}

/** One `preview_list` line after the name. */
function describe(entry: Entry): string {
  const tail = ` — shell ${entry.shellID}, \`${entry.command}\``;
  switch (entry.status) {
    case "running":
      return (
        `${entry.url} — running` +
        (entry.opened ? ", shown to the user" : "") +
        tail
      );
    case "exited":
      return `exited (code ${entry.exit ?? "?"})${tail}`;
    default:
      return `${entry.status}${tail}`;
  }
}
