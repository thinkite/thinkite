// The preview tools as opencode sees them: `thinkite_<name>`, called in
// Code Mode as `tools.thinkite.<name>(…)`. `server_*` run servers, pages
// and APIs alike; `preview_open` shows one's page to the user. Code Mode's
// catalog shows only the first line of each description, cut at 120
// characters, and MCP `instructions` never reach the model for attached
// clients — so each first line is the whole guidance, and names the other
// side of the server/preview pair (tools.test.ts holds them under 120).

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
        "Run a dev server or API in the background (not shell background/nohup); to show a page, then call preview_open.\n" +
        "Use for any long-running process the user or a page reaches over the network: web dev servers, API servers, " +
        "websocket servers, tunnels. Servers started with the shell tool's background mode or nohup are invisible to " +
        "the user and their phone. Returns the first output, where servers usually print their URL; if it is not there " +
        "yet, check server_logs. The user sees every server in their Servers list; preview_open puts a page in their " +
        "browser. Starting a name that is already running returns it instead of restarting it.",
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
        ),
      ),
    },
    {
      name: "preview_open",
      description:
        "Show the user a page served by a server_start server, once its output says the URL it serves.\n" +
        "Pass the server's name and the URL from its output. A URL on this machine must be served by that server's " +
        "processes; a tunnel or public URL is taken as given. Not for APIs or backends the user does not look at. " +
        "Calling it again shows the page again.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The server_start name" },
          url: {
            type: "string",
            description: "The URL from its output, e.g. http://localhost:5173/",
          },
        },
        required: ["name", "url"],
      },
      call: nameOnly((n, args, ctx) => {
        const url = str(args.url);
        if (!url)
          return Promise.resolve({ text: "url is required", isError: true });
        return registry.open(ctx.directory, n, url, ctx.sessionID);
      }),
    },
    {
      name: "server_list",
      description:
        "List servers started with server_start: status, and the URL if preview_open showed it.\n" +
        "Shows this session's servers; pass all: true for every server in the project.",
      inputSchema: {
        type: "object",
        properties: {
          all: {
            type: "boolean",
            description: "Every server in the project, not just this session's",
          },
        },
      },
      call: (args, ctx) =>
        registry.list(ctx.directory, ctx.sessionID, args.all === true),
    },
    {
      name: "server_stop",
      description: "Stop a server started with server_start and free its port.",
      inputSchema: {
        type: "object",
        properties: { name },
        required: ["name"],
      },
      call: nameOnly((n, _args, ctx) =>
        registry.stop(ctx.directory, n, ctx.sessionID),
      ),
    },
  ];
}
