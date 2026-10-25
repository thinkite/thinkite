// The preview tools as opencode sees them: `thinkite_<name>`, called in
// Code Mode as `tools.thinkite.<name>(…)`. `server_*` run servers, pages
// and APIs alike. Nothing here opens a page for the user: the agent writes
// the link in its reply, and whichever client the user reads it in opens
// it (docs/preview-tool-v1.md). Code Mode's catalog shows only the first
// line of each description, cut at 120 characters, and MCP `instructions`
// never reach the model for attached clients — so each first line is the
// whole guidance (tools.test.ts holds them under 120).

import type { PreviewRegistry, ToolOutcome } from "./registry.ts";

type Ctx = { directory: string; sessionID?: string };

export interface PreviewTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>, ctx: Ctx): Promise<ToolOutcome>;
}

const str = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

export function previewTools(registry: PreviewRegistry): PreviewTool[] {
  const nameOnly =
    (
      run: (
        name: string,
        args: Record<string, unknown>,
        ctx: Ctx,
      ) => Promise<ToolOutcome>,
    ) =>
    (args: Record<string, unknown>, ctx: Ctx) => {
      const name = str(args.name);
      if (!name)
        return Promise.resolve({ text: "name is required", isError: true });
      return run(name, args, ctx);
    };
  const name = {
    type: "string",
    description: "Short label, unique in this project, e.g. web or api",
  };
  return [
    {
      name: "server_start",
      description:
        "Run a dev server or API in the background (not shell background/nohup); to show a page, write its URL in your reply.\n" +
        "Use for any long-running process the user or a page reaches over the network: web dev servers, API servers, " +
        "websocket servers, tunnels. Servers started with the shell tool's background mode or nohup are invisible to " +
        "the user and their phone. Returns the first output and, once the server listens, its URL; if it is not ready " +
        "yet, check server_logs. The user sees every server in their Servers list and opens a page from a link in " +
        "your reply, on their Mac or phone; do not run `open` on a URL, which only reaches this Mac's default browser. " +
        "Names are per project: starting a name that is already running returns it instead of restarting it.",
      inputSchema: {
        type: "object",
        properties: {
          name,
          command: {
            type: "string",
            description:
              "Shell command that starts the server, e.g. npm run dev or PORT=8080 bun server.ts",
          },
          cwd: {
            type: "string",
            description:
              "Working directory, absolute or relative to the project",
          },
        },
        required: ["name", "command"],
      },
      call: nameOnly((n, args, ctx) =>
        registry.start(
          ctx.directory,
          { name: n, command: str(args.command), cwd: str(args.cwd) },
          ctx.sessionID,
        ),
      ),
    },
    {
      name: "server_logs",
      description:
        "Show a server_start server's recent output: whether it is ready, and the URL it serves.",
      inputSchema: {
        type: "object",
        properties: {
          name,
          lines: {
            type: "number",
            description:
              "How many lines from the end (default 40, at most 200)",
          },
        },
        required: ["name"],
      },
      call: nameOnly((n, args, ctx) =>
        registry.logs(
          ctx.directory,
          n,
          typeof args.lines === "number" ? args.lines : undefined,
          ctx.sessionID,
        ),
      ),
    },
    {
      name: "server_list",
      description:
        "List this project's servers: status, URL, which are yours, and why one stopped.",
      inputSchema: { type: "object", properties: {} },
      call: (_args, ctx) => registry.list(ctx.directory, ctx.sessionID),
    },
    {
      name: "server_stop",
      description:
        "Stop a server started with server_start and free its port.\n" +
        "Any of the project's servers can be stopped, another session's too; server_list marks yours.",
      inputSchema: {
        type: "object",
        properties: { name },
        required: ["name"],
      },
      call: nameOnly((n, _args, ctx) =>
        registry.stop(ctx.directory, n, {
          by: "agent",
          ...(ctx.sessionID === undefined ? {} : { sessionID: ctx.sessionID }),
        }),
      ),
    },
  ];
}
