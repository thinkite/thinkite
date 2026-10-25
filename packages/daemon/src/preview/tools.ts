// The four preview tools as opencode sees them: `thinkite_<name>`, called in
// Code Mode as `tools.thinkite.<name>(…)`. Code Mode's catalog shows only
// the first line of each description, cut at 120 characters, and MCP
// `instructions` never reach the model for attached clients — so each
// first line is the whole guidance (tools.test.ts holds them under 120).

import type { PreviewRegistry, ToolOutcome } from "./registry.ts";

export interface PreviewTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(
    args: Record<string, unknown>,
    ctx: { directory: string; sessionID?: string },
  ): Promise<ToolOutcome>;
}

const str = (v: unknown) =>
  typeof v === "string" && v.trim() !== "" ? v : undefined;

const isPort = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65536;

export function previewTools(registry: PreviewRegistry): PreviewTool[] {
  return [
    {
      name: "preview_start",
      description:
        "Run a dev server or API in the background so the user can open it (use this, not shell background/nohup).\n" +
        "Use for any long-running process the user or a page reaches over the network: web dev servers, API servers, " +
        "websocket servers. Servers started with the shell tool's background mode or nohup are invisible to the user's " +
        "phone. Set open: true only for a page the user should look at in a browser; leave it false for APIs and other " +
        "backends. Pass port when you know it from the config, script or flags. Starting a name that is already running " +
        "returns it instead of restarting it. Returns the URL once the port is listening.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Short label, unique in this project, e.g. web or api",
          },
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
          open: {
            type: "boolean",
            description: "Show it to the user in the preview pane (pages only)",
          },
          port: {
            type: "integer",
            description:
              "The port it will listen on, if you know it (from its config, script or flags)",
          },
        },
        required: ["name", "command"],
      },
      call: (args, ctx) => {
        const name = str(args.name);
        if (!name)
          return Promise.resolve({ text: "name is required", isError: true });
        return registry.start(
          ctx.directory,
          {
            name,
            command: str(args.command),
            cwd: str(args.cwd),
            open: args.open === true,
            ...(isPort(args.port) ? { port: args.port } : {}),
          },
          ctx.sessionID,
        );
      },
    },
    {
      name: "preview_list",
      description:
        "List servers started with preview_start: URL, status, and whether it was shown to the user.\n" +
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
      name: "preview_logs",
      description:
        "Show the recent output of a server started with preview_start.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          lines: {
            type: "number",
            description:
              "How many lines from the end (default 40, at most 200)",
          },
        },
        required: ["name"],
      },
      call: (args, ctx) => {
        const name = str(args.name);
        if (!name)
          return Promise.resolve({ text: "name is required", isError: true });
        return registry.logs(
          ctx.directory,
          name,
          typeof args.lines === "number" ? args.lines : undefined,
        );
      },
    },
    {
      name: "preview_stop",
      description:
        "Stop a server started with preview_start and free its port.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      call: (args, ctx) => {
        const name = str(args.name);
        if (!name)
          return Promise.resolve({ text: "name is required", isError: true });
        return registry.stop(ctx.directory, name, ctx.sessionID);
      },
    },
  ];
}
