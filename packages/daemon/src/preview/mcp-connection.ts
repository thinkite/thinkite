// One client-hosted MCP connection to opencode for one directory: we are the
// MCP server, opencode is the client, JSON-RPC over a WebSocket to
// `/api/experimental/client-mcp`, one message per text frame. Same wire as
// `connectClientMcp` in `@opencode/client/mcp`, written out so the host can
// rebuild the registry each time the connection comes up.
//
// opencode pins attached connections to the legacy handshake
// (`packages/core/src/mcp/client.ts`: `config.type === "attached" ?
// "legacy"`), so this speaks 2025-11-25: initialize, ping, tools/list,
// tools/call. If `connectClientMcp` ever moves to 2026-07-28, follow it.
//
// Keep the connection up for the daemon's lifetime: every attach or detach
// makes opencode re-inject its whole Code Mode catalog (~9k characters)
// into each session in the directory (anomalyco/opencode#55529).

import type { ResolveOpencode } from "../opencode/service.ts";
import { authorization } from "./shells.ts";
import type { PreviewTool } from "./tools.ts";

const NAME = "thinkite";
const PROTOCOL_VERSION = "2025-11-25";
const SESSION_META = "ai.opencode/sessionID";
const RECONNECT_MIN = 500;
const RECONNECT_MAX = 10_000;

export interface McpConnectionOptions {
  directory: string;
  resolve: ResolveOpencode;
  tools: PreviewTool[];
  version: string;
  /** After each `notifications/initialized`: the tools are live again. */
  onReady?: () => void;
  log?: (message: string) => void;
}

type Message = {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
};

export class McpConnection {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay = RECONNECT_MIN;
  private closed = false;
  private readonly log: (message: string) => void;

  constructor(private readonly options: McpConnectionOptions) {
    this.log = options.log ?? (() => undefined);
    void this.connect();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close(1000);
    this.socket = null;
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    let conn: Awaited<ReturnType<ResolveOpencode>>;
    try {
      conn = await this.options.resolve();
    } catch {
      return this.retry();
    }
    if (this.closed) return;
    const url = new URL(
      "api/experimental/client-mcp",
      conn.baseUrl.endsWith("/") ? conn.baseUrl : `${conn.baseUrl}/`,
    );
    url.searchParams.set("location[directory]", this.options.directory);
    url.searchParams.set("name", NAME);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    // Node ≥ 22 and Bun both take handshake headers as a second argument.
    const socket = new WebSocket(url, {
      headers: { authorization: authorization(conn) },
    } as unknown as string[]);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      void this.handle(socket, event.data);
    });
    socket.addEventListener("close", () => {
      if (this.socket === socket) this.socket = null;
      this.retry();
    });
    socket.addEventListener("error", () => undefined);
  }

  private retry(): void {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.connect();
    }, this.delay);
    this.delay = Math.min(this.delay * 2, RECONNECT_MAX);
  }

  private async handle(socket: WebSocket, text: string): Promise<void> {
    let message: Message;
    try {
      message = JSON.parse(text) as Message;
    } catch {
      return;
    }
    if (message.method === "notifications/initialized") {
      this.delay = RECONNECT_MIN;
      this.log(`preview mcp attached ${this.options.directory}`);
      this.options.onReady?.();
      return;
    }
    if (message.id === undefined || typeof message.method !== "string") return;
    const reply = await this.respond(message.method, message.params ?? {});
    if (socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, ...reply }));
  }

  private async respond(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (method) {
      case "initialize":
        return {
          result: {
            protocolVersion:
              typeof params.protocolVersion === "string"
                ? params.protocolVersion
                : PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: NAME, version: this.options.version },
          },
        };
      case "ping":
        return { result: {} };
      case "tools/list":
        return {
          result: {
            tools: this.options.tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        };
      case "tools/call": {
        const tool = this.options.tools.find((t) => t.name === params.name);
        if (!tool)
          return {
            error: {
              code: -32602,
              message: `Unknown tool: ${String(params.name)}`,
            },
          };
        const meta = (params._meta ?? {}) as Record<string, unknown>;
        const sessionID =
          typeof meta[SESSION_META] === "string"
            ? (meta[SESSION_META] as string)
            : undefined;
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        try {
          const outcome = await tool.call(args, {
            directory: this.options.directory,
            sessionID,
          });
          return {
            result: {
              content: [{ type: "text", text: outcome.text }],
              isError: outcome.isError === true,
            },
          };
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this.log(`preview ${tool.name} failed: ${text}`);
          return {
            result: { content: [{ type: "text", text }], isError: true },
          };
        }
      }
      default:
        return {
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }
  }
}
