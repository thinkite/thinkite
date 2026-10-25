// The three preview tools as opencode sees them: `thinkite_<name>`, called in
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

export function previewTools(registry: PreviewRegistry): PreviewTool[] {
  return [
    {
      name: "preview_open",
      description:
        "Show a server you started with the shell tool's background mode in the user's browser: name, shell ID, URL.\n" +
        "Start the server first (shell tool, background: true) and wait until its output shows the URL it serves; " +
        "pass the shell ID from that result and that URL. open defaults to true; set it false for an API or other " +
        "backend the user does not look at, so it still shows in their Servers list. A URL on this machine must be " +
        "served by that shell's processes; a tunnel or public URL is taken as given. Calling again with the same name " +
        "and shell shows it again; a running name with another shell is refused until you preview_stop it.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Short label, unique in this project, e.g. web or api",
          },
          shellID: {
            type: "string",
            description:
              "The shell ID the shell tool returned for the background command",
          },
          url: {
            type: "string",
            description:
              "The URL the server printed, e.g. http://localhost:5173/",
          },
          open: {
            type: "boolean",
            description:
              "Show it to the user (default true); false for APIs and backends",
          },
        },
        required: ["name", "shellID", "url"],
      },
      call: (args, ctx) => {
        const name = str(args.name);
        const shellID = str(args.shellID);
        const url = str(args.url);
        if (!name || !shellID || !url)
          return Promise.resolve({
            text: "name, shellID and url are required",
            isError: true,
          });
        return registry.open(
          ctx.directory,
          { name, shellID, url, open: args.open !== false },
          ctx.sessionID,
        );
      },
    },
    {
      name: "preview_list",
      description:
        "List servers registered with preview_open: URL, status, shell ID, and whether it was shown to the user.\n" +
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
      name: "preview_stop",
      description:
        "Stop a server registered with preview_open: kills its shell and frees its port.",
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
