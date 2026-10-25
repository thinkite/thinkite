// PreviewHost: serves the preview tools to the user's opencode service and
// keeps the registry in step with it.
//
// - One MCP connection per session directory, opened the first time the
//   daemon sees the directory (the recent sessions at start, then
//   `session.created` events) and kept until the daemon stops. opencode
//   scopes client tools to the exact directory: a connection for
//   `proj/web` is invisible to a session at `proj`.
// - Each time a connection comes up, the registry re-checks that
//   directory's entries against their shells.
// - opencode's event bus feeds `shell.exited` into the registry, so a
//   server that dies shows up as stopped without anyone polling.

import { access } from "node:fs/promises";
import { listRecentSessions } from "../opencode/recent.ts";
import type { ResolveOpencode } from "../opencode/service.ts";
import { McpConnection } from "./mcp-connection.ts";
import { PreviewRegistry } from "./registry.ts";
import { createShellApi, opencodeClient, type ShellStatus } from "./shells.ts";
import { previewTools } from "./tools.ts";

export interface PreviewHostOptions {
  resolve: ResolveOpencode;
  version: string;
  /** Where the registry persists (`$THINKITE_HOME/previews.json`). */
  stateFile?: string;
  log?: (message: string) => void;
}

export class PreviewHost {
  readonly registry: PreviewRegistry;
  private readonly connections = new Map<string, McpConnection>();
  private readonly abort = new AbortController();
  private readonly log: (message: string) => void;

  constructor(private readonly options: PreviewHostOptions) {
    this.log = options.log ?? (() => undefined);
    this.registry = new PreviewRegistry({
      shells: createShellApi(options.resolve),
      ...(options.stateFile === undefined
        ? {}
        : { stateFile: options.stateFile }),
      log: this.log,
    });
  }

  start(): void {
    void this.attachRecent();
    void this.followEvents();
  }

  stop(): void {
    this.abort.abort();
    for (const connection of this.connections.values()) connection.close();
    this.connections.clear();
  }

  /** Serve the tools to sessions in `directory` (idempotent). */
  async attach(directory: string): Promise<void> {
    if (this.connections.has(directory) || this.abort.signal.aborted) return;
    try {
      await access(directory);
    } catch {
      return;
    }
    if (this.connections.has(directory)) return;
    const tools = previewTools(this.registry);
    this.connections.set(
      directory,
      new McpConnection({
        directory,
        resolve: this.options.resolve,
        tools,
        version: this.options.version,
        log: this.log,
        onReady: () => {
          this.registry.rebuild(directory).catch((err: unknown) => {
            this.log(
              `preview rebuild ${directory}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        },
      }),
    );
  }

  private async attachRecent(): Promise<void> {
    for (
      let delay = 1000;
      !this.abort.signal.aborted;
      delay = Math.min(delay * 2, 30_000)
    ) {
      try {
        const sessions = await listRecentSessions(await this.options.resolve());
        for (const directory of new Set(sessions.map((s) => s.directory)))
          await this.attach(directory);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async followEvents(): Promise<void> {
    for (let delay = 1000; !this.abort.signal.aborted; ) {
      try {
        const client = opencodeClient(await this.options.resolve());
        for await (const event of client.event.subscribe({
          signal: this.abort.signal,
        })) {
          delay = 1000;
          this.onEvent(event as { type: string; data?: unknown });
        }
      } catch {
        // No service yet, or the stream broke (service restart): retry.
      }
      if (this.abort.signal.aborted) return;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private onEvent(event: { type: string; data?: unknown }): void {
    switch (event.type) {
      case "session.created": {
        const data = event.data as { location?: { directory?: string } };
        if (data.location?.directory) void this.attach(data.location.directory);
        return;
      }
      case "shell.exited": {
        const data = event.data as {
          id: string;
          status: ShellStatus;
          exit?: number;
        };
        this.registry.shellExited(data.id, data.status, data.exit);
        return;
      }
    }
  }
}
