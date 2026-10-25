// The daemon's list of servers the agent started with `server_start`, per
// project directory, and of its requests to open pages in the user's
// browser (docs/preview-tool-v1.md).
//
// The daemon creates each server's shell itself and hands the agent its
// output; the agent reads the URL there and calls `browser_open` when the
// server is ready. opencode's shell says whether a server still runs; the
// rest (name, URL, who started and stopped it, the open requests) only
// exists here, so it is kept in a small file in the Thinkite home and read
// back when the daemon starts.

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { resolve as resolvePath } from "node:path";
import type {
  BrowserRequest,
  ForwardPort,
  PreviewEntry,
} from "@thinkite/protocol";
import { listeningPorts } from "./ports.ts";
import type { ShellApi, ShellStatus } from "./shells.ts";

export interface ToolOutcome {
  text: string;
  isError?: boolean;
}

export interface StartInput {
  name: string;
  command?: string;
  cwd?: string;
}

/** Who stops a server: the user's stop button, or an agent's server_stop. */
export type Stopper = { by: "user" } | { by: "agent"; sessionID?: string };

export interface PreviewSnapshot {
  entries: PreviewEntry[];
  requests: BrowserRequest[];
}

export interface RegistryOptions {
  shells: ShellApi;
  ports?: (pid: number) => Promise<number[]>;
  sleep?: (ms: number) => Promise<void>;
  /** Runs `fn` after `ms`; the forward-port checks after a start use it. */
  schedule?: (fn: () => void, ms: number) => void;
  /** How long `start` collects output before answering. */
  startWaitMs?: number;
  /** Where entries persist across daemon restarts. Absent: memory only. */
  stateFile?: string;
  log?: (message: string) => void;
}

type Ended = NonNullable<PreviewEntry["ended"]>;

interface Entry {
  directory: string;
  name: string;
  shellID: string;
  pid?: number;
  command: string;
  cwd?: string;
  /** The page `browser_open` last opened from this server. */
  url?: string;
  /** That URL's port (checked to be this server's). */
  localPort?: number;
  status: PreviewEntry["status"];
  started: PreviewEntry["started"];
  ended?: Ended;
}

interface Request extends BrowserRequest {
  directory: string;
}

interface StateFile {
  v: 2;
  entries: Entry[];
  requests: Request[];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes start with ESC
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const LOG_BYTES = 32 * 1024;
const POLL_MS = 250;
/** After a start, when to look again for the server's ports: servers
 *  open them a moment after their shell starts, some only on first use. */
const PORT_CHECKS_MS = [1_000, 3_000, 10_000, 30_000];
/** Open requests kept per directory (the latest per session and origin). */
const MAX_REQUESTS = 100;

export class PreviewRegistry {
  private readonly shells: ShellApi;
  private readonly ports: (pid: number) => Promise<number[]>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly schedule: (fn: () => void, ms: number) => void;
  private readonly startWaitMs: number;
  private readonly stateFile?: string;
  private readonly log: (message: string) => void;

  private readonly dirs = new Map<string, Map<string, Entry>>();
  /** Per directory, keyed by session and origin: the latest request. */
  private readonly requests = new Map<string, Map<string, Request>>();
  /** Shells being stopped through `stop`, so their exit event is theirs. */
  private readonly stopping = new Map<string, Stopper>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly listeners = new Map<
    string,
    Set<(snapshot: PreviewSnapshot) => void>
  >();
  private readonly portListeners = new Set<(ports: ForwardPort[]) => void>();
  private lastPorts = "[]";

  constructor(options: RegistryOptions) {
    this.shells = options.shells;
    this.ports = options.ports ?? listeningPorts;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.schedule =
      options.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref?.());
    this.startWaitMs = options.startWaitMs ?? 2_000;
    this.stateFile = options.stateFile;
    this.log = options.log ?? (() => undefined);
    this.load();
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

  async logs(
    directory: string,
    name: string,
    lines = 40,
    sessionID?: string,
  ): Promise<ToolOutcome> {
    const entry = this.dir(directory).get(name);
    if (!entry) return noServer(name);
    await this.refresh(entry).catch(() => undefined);
    const text = await this.tail(entry, Math.min(Math.max(1, lines), 200));
    return {
      text: `"${name}" ${state(entry, sessionID)}.\n${text || "(no output yet)"}`,
    };
  }

  async list(directory: string, sessionID?: string): Promise<ToolOutcome> {
    const entries = await this.refreshAll(directory);
    if (entries.length === 0) return { text: "No servers in this project." };
    return {
      text: entries
        .map(
          (e) =>
            `${e.name}: ${state(e, sessionID)}` +
            (e.status === "running" && e.url ? `, ${e.url}` : "") +
            ` — \`${e.command}\`` +
            (sessionID !== undefined && e.started.sessionID === sessionID
              ? " (yours)"
              : ""),
        )
        .join("\n"),
    };
  }

  stop(
    directory: string,
    name: string,
    stopper: Stopper,
  ): Promise<ToolOutcome> {
    return this.locked(`${directory}\0${name}`, async () => {
      const entry = this.dir(directory).get(name);
      if (!entry) return noServer(name);
      const caller = stopper.by === "agent" ? stopper.sessionID : undefined;
      await this.refresh(entry).catch(() => undefined);
      if (entry.status !== "running")
        return {
          text: `"${name}" is not running: it ${ended(entry, caller)}.`,
        };
      this.stopping.set(entry.shellID, stopper);
      try {
        await this.shells
          .remove(directory, entry.shellID)
          .catch(() => undefined);
        if (entry.pid !== undefined) {
          for (
            let i = 0;
            i < 12 && (await this.ports(entry.pid)).length > 0;
            i++
          )
            await this.sleep(POLL_MS);
        }
      } finally {
        this.stopping.delete(entry.shellID);
      }
      // Kept as ended, not dropped: clients show it stopped, and the next
      // start of the name says so. That start replaces it.
      this.end(entry, { at: Date.now(), ...stopper });
      this.changed(directory);
      void this.checkPorts();
      return {
        text:
          `Stopped "${name}".` +
          (stopper.by === "agent" && entry.started.sessionID !== caller
            ? " Another session started it; it stopped there too."
            : ""),
      };
    });
  }

  async open(
    directory: string,
    raw: string,
    sessionID?: string,
  ): Promise<ToolOutcome> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { text: `Not a URL: ${raw}`, isError: true };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return { text: "The URL must be http or https.", isError: true };
    if (sessionID === undefined)
      return { text: "No session to show it in.", isError: true };

    // The one fact checked: a URL on this machine is served by one of this
    // project's servers. Others (a tunnel, a public site) are taken as given.
    let server: Entry | undefined;
    if (isThisMachine(url.hostname)) {
      const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
      const entries = await this.refreshAll(directory);
      const running = entries.filter((e) => e.status === "running");
      const listening = await Promise.all(
        running.map(async (e) => ({
          entry: e,
          ports: e.pid === undefined ? [] : await this.ports(e.pid),
        })),
      );
      server = listening.find((l) => l.ports.includes(port))?.entry;
      if (server === undefined) {
        const gone = entries.find(
          (e) => e.status !== "running" && e.localPort === port,
        );
        const others = listening
          .filter((l) => l.ports.length > 0)
          .map((l) => `"${l.entry.name}" listens on ${l.ports.join(", ")}`);
        return {
          text:
            (gone
              ? `"${gone.name}", which served port ${port}, ${ended(gone, sessionID)}.`
              : `No server started with server_start in this project listens on ${port}` +
                (others.length > 0
                  ? ` (${others.join("; ")}).`
                  : ". Start it with server_start, or wait until its output says it is ready.")) +
            " Nothing was opened.",
          isError: true,
        };
      }
      server.url = url.href;
      server.localPort = port;
    }

    const requests = this.requestsOf(directory);
    const key = `${sessionID}\0${url.origin}`;
    requests.delete(key);
    requests.set(key, {
      directory,
      url: url.href,
      sessionID,
      at: Date.now(),
      ...(server === undefined ? {} : { server: server.name }),
    });
    for (const old of requests.keys()) {
      if (requests.size <= MAX_REQUESTS) break;
      requests.delete(old);
    }
    this.log(`browser open ${url.href} in ${directory}`);
    this.changed(directory);
    return { text: `Sent ${url.href} to the user's browser.` };
  }

  // ─── Clients ────────────────────────────────────────────────────────────

  /** The directory's servers (re-checked against the shells) and open
   *  requests. */
  async snapshot(directory: string): Promise<PreviewSnapshot> {
    await this.refreshAll(directory);
    return this.current(directory);
  }

  subscribe(
    directory: string,
    listener: (snapshot: PreviewSnapshot) => void,
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

  /** Every port the running servers of every project listen on: what the
   *  phone forwards while it is in the foreground. */
  async forwardPorts(): Promise<ForwardPort[]> {
    await this.checkPorts();
    return JSON.parse(this.lastPorts) as ForwardPort[];
  }

  subscribePorts(listener: (ports: ForwardPort[]) => void): () => void {
    this.portListeners.add(listener);
    return () => {
      this.portListeners.delete(listener);
    };
  }

  // ─── opencode side ──────────────────────────────────────────────────────

  /** Re-check the directory's entries against their shells: after a daemon
   *  restart or an opencode reconnect, `shell.exited` may have been missed. */
  async rebuild(directory: string): Promise<void> {
    await this.refreshAll(directory);
    void this.checkPorts();
  }

  /** opencode's `shell.exited` event. */
  shellExited(shellID: string, status: ShellStatus, exit?: number): void {
    for (const [directory, dir] of this.dirs) {
      for (const entry of dir.values()) {
        if (entry.shellID !== shellID || entry.status !== "running") continue;
        this.end(entry, this.cause(entry, status, exit));
        this.changed(directory);
        void this.checkPorts();
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
    if (existing?.status === "running") await this.refresh(existing);
    const command = input.command?.trim() || undefined;
    if (existing?.status === "running") {
      if (command !== undefined && command !== existing.command)
        return {
          text: `"${input.name}" is already running \`${existing.command}\`; stop it first to change it.`,
          isError: true,
        };
      return {
        text: `"${input.name}" is already running${existing.url ? ` at ${existing.url}` : ""}. Recent output:\n${(await this.tail(existing, 20)) || "(none)"}`,
      };
    }
    if (command === undefined)
      return { text: "command is required to start a server.", isError: true };

    // Read before the entry is replaced: the agent should know a server of
    // this name was stopped, and by whom.
    const note = existing
      ? `\nNote: the previous "${input.name}" ${ended(existing, sessionID)}.`
      : "";
    const cwd =
      input.cwd === undefined ? undefined : resolvePath(directory, input.cwd);
    const shell = await this.shells.create(directory, {
      command,
      ...(cwd === undefined ? {} : { cwd }),
      metadata: {
        thinkite: { server: input.name, session: sessionID ?? null },
      },
    });
    const entry: Entry = {
      directory,
      name: input.name,
      shellID: shell.id,
      ...(shell.pid === undefined ? {} : { pid: shell.pid }),
      command,
      ...(cwd === undefined ? {} : { cwd }),
      status: "running",
      started: {
        at: shell.time?.started ?? Date.now(),
        ...(sessionID === undefined ? {} : { sessionID }),
      },
    };
    dir.set(entry.name, entry);
    this.log(
      `server start ${entry.name} (${shell.id}) in ${directory}: ${command}`,
    );
    this.changed(directory);
    for (const ms of PORT_CHECKS_MS)
      this.schedule(() => void this.checkPorts(), ms);

    // Hand the agent the first output (where servers print their URL);
    // whether it is ready is the agent's call.
    for (let waited = 0; waited < this.startWaitMs; waited += POLL_MS) {
      await this.sleep(POLL_MS);
      await this.refresh(entry);
      if (entry.status !== "running") {
        this.changed(directory);
        const how =
          entry.ended?.by === "process"
            ? `exited right away${entry.ended.exit === undefined ? "" : ` (code ${entry.ended.exit})`}`
            : `${ended(entry, sessionID)}, right after starting`;
        return {
          text: `"${entry.name}" ${how}. Output:\n${(await this.tail(entry, 40)) || "(none)"}${note}`,
          isError: true,
        };
      }
    }
    return {
      text: `Started "${entry.name}". Output so far:\n${(await this.tail(entry, 40)) || "(none yet)"}${note}`,
    };
  }

  /** Re-check one entry's shell. */
  private async refresh(entry: Entry): Promise<void> {
    if (entry.status !== "running") return;
    const info = await this.shells.get(entry.directory, entry.shellID);
    if (info?.status !== "running")
      this.end(entry, this.cause(entry, info?.status ?? "killed", info?.exit));
    else if (entry.pid === undefined && info.pid !== undefined)
      entry.pid = info.pid;
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

  /** Why a shell ended, from its status: a `stop` in progress, the
   *  process's own exit, or something outside Thinkite (opencode's kill
   *  button, a service restart). */
  private cause(entry: Entry, status: ShellStatus, exit?: number): Ended {
    const stopper = this.stopping.get(entry.shellID);
    if (stopper) return { at: Date.now(), ...stopper };
    if (status === "exited")
      return {
        at: Date.now(),
        by: "process",
        ...(exit === undefined ? {} : { exit }),
      };
    return { at: Date.now(), by: "external" };
  }

  private end(entry: Entry, cause: Ended): void {
    entry.status = "ended";
    entry.ended = cause;
  }

  /** Recompute the ports to forward and push them when they changed. */
  private async checkPorts(): Promise<void> {
    const running = [...this.dirs.values()].flatMap((d) =>
      [...d.values()].filter((e) => e.status === "running"),
    );
    const found = await Promise.all(
      running.map(async (e) =>
        (e.pid === undefined
          ? []
          : await this.ports(e.pid).catch(() => [])
        ).map(
          (port): ForwardPort => ({
            port,
            directory: e.directory,
            name: e.name,
          }),
        ),
      ),
    );
    const ports = found.flat().sort((a, b) => a.port - b.port);
    const text = JSON.stringify(ports);
    if (text === this.lastPorts) return;
    this.lastPorts = text;
    for (const listener of this.portListeners) listener(ports);
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

  private current(directory: string): PreviewSnapshot {
    return {
      entries: [...this.dir(directory).values()].map(toPublic),
      requests: [...this.requestsOf(directory).values()].map(
        ({ directory: _, ...request }) => request,
      ),
    };
  }

  /** Persist, then push to the directory's clients. */
  private changed(directory: string): void {
    this.save();
    const listeners = this.listeners.get(directory);
    if (!listeners || listeners.size === 0) return;
    const snapshot = this.current(directory);
    for (const listener of listeners) listener(snapshot);
  }

  /** Running entries come back and `rebuild` re-checks them; ones that had
   *  already ended are left behind. Open requests all come back. */
  private load(): void {
    if (this.stateFile === undefined) return;
    let state: StateFile;
    try {
      state = JSON.parse(readFileSync(this.stateFile, "utf8")) as StateFile;
    } catch {
      return;
    }
    if (state.v !== 2) return;
    for (const entry of state.entries ?? [])
      if (entry.status === "running")
        this.dir(entry.directory).set(entry.name, entry);
    for (const request of state.requests ?? [])
      this.requestsOf(request.directory).set(
        `${request.sessionID}\0${new URL(request.url).origin}`,
        request,
      );
  }

  private save(): void {
    if (this.stateFile === undefined) return;
    const state: StateFile = {
      v: 2,
      entries: [...this.dirs.values()].flatMap((d) => [...d.values()]),
      requests: [...this.requests.values()].flatMap((r) => [...r.values()]),
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

  private requestsOf(directory: string): Map<string, Request> {
    let requests = this.requests.get(directory);
    if (!requests) {
      requests = new Map();
      this.requests.set(directory, requests);
    }
    return requests;
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

const noServer = (name: string): ToolOutcome => ({
  text: `No server named "${name}" in this project. List them, or start it first.`,
  isError: true,
});

/** "is running", or how it ended: "was stopped by the user 3 min ago". */
function state(entry: Entry, sessionID?: string): string {
  return entry.status === "running" ? "is running" : ended(entry, sessionID);
}

/** How a server ended, for the agent `sessionID`: the words carry who did
 *  it, so an agent that finds it gone knows whether to start it again. */
function ended(entry: Entry, sessionID?: string): string {
  const e = entry.ended;
  if (!e) return "is running";
  const when = ago(e.at);
  switch (e.by) {
    case "user":
      return `was stopped by the user ${when}`;
    case "agent":
      return e.sessionID !== undefined && e.sessionID === sessionID
        ? `was stopped by you ${when}`
        : `was stopped by another session ${when}`;
    case "process":
      return `exited${e.exit === undefined ? "" : ` (code ${e.exit})`} ${when}`;
    default:
      return `was killed outside Thinkite ${when}`;
  }
}

function ago(at: number): string {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function toPublic(entry: Entry): PreviewEntry {
  return {
    name: entry.name,
    ...(entry.url === undefined ? {} : { url: entry.url }),
    ...(entry.localPort === undefined ? {} : { localPort: entry.localPort }),
    status: entry.status,
    command: entry.command,
    started: entry.started,
    ...(entry.ended === undefined ? {} : { ended: entry.ended }),
  };
}
