import type { SessionMessageInfo } from "@thinkite/oc-client";
import { describe, expect, it } from "vitest";
import { toolVerb } from "./tool-verbs";
import { flattenToBlocks, type ToolRenderBlock } from "./transcript-blocks";

// Shapes as opencode 2.1.3 records them (checked against a live service).
function toolRow(
  name: string,
  input: Record<string, unknown>,
  text: string,
  metadata: Record<string, unknown> = {},
): ToolRenderBlock {
  const message = {
    id: "msg_1",
    type: "assistant",
    content: [
      {
        type: "tool",
        id: "call_1",
        name,
        state: {
          status: "completed",
          input,
          content: [{ type: "text", text }],
          metadata,
        },
      },
    ],
  } as unknown as SessionMessageInfo;
  const [block] = flattenToBlocks([message]);
  if (block?.kind !== "tool") throw new Error("expected a tool row");
  return block;
}

describe("flattenToBlocks tool rows", () => {
  it("reads shell as a command", () => {
    const row = toolRow(
      "shell",
      { command: "ls -la\necho done", timeout: 120000, workdir: "/repo" },
      "total 0\n",
      { exit: 0, status: "completed" },
    );
    expect(row.detail).toMatchObject({
      type: "bash",
      command: "ls -la\necho done",
      output: "total 0",
    });
    expect(toolVerb(row.detail)).toBe("Ran");
    expect(row.summary).toBe("ls -la");
  });

  it("reads subagent as an agent, without its wrapper", () => {
    const row = toolRow(
      "subagent",
      { agent: "general", description: "Count files", prompt: "Count them." },
      '<subagent sessionID="ses_2" state="completed">\n21 files.\n</subagent>',
      { sessionID: "ses_2", status: "completed" },
    );
    expect(row.detail).toMatchObject({
      type: "agent",
      subagentType: "general",
      prompt: "Count them.",
      output: "21 files.",
    });
    expect(toolVerb(row.detail)).toBe("Ran agent");
    expect(row.summary).toBe("Count files");
  });

  it("reads skill by its name, with the skill's text", () => {
    const row = toolRow(
      "skill",
      { id: "opencode" },
      '<skill_content name="OpenCode">\n# Skill: OpenCode\n\nUse this guide.\n</skill_content>',
      { name: "OpenCode", directory: "/builtin" },
    );
    expect(row.detail).toMatchObject({
      type: "skill",
      name: "OpenCode",
      content: "# Skill: OpenCode\n\nUse this guide.",
    });
    expect(toolVerb(row.detail)).toBe("Loaded skill");
    expect(row.summary).toBe("OpenCode");
  });

  it("reads execute as code, summed up by the tools it called", () => {
    const row = toolRow(
      "execute",
      { code: 'return search({ query: "x" });' },
      '{ "items": [] }',
      {
        toolCalls: [
          { tool: "search", status: "completed" },
          { tool: "search", status: "completed" },
          { tool: "browser.screenshot", status: "completed" },
        ],
      },
    );
    expect(row.detail).toMatchObject({
      type: "code",
      code: 'return search({ query: "x" });',
      output: '{ "items": [] }',
    });
    expect(toolVerb(row.detail)).toBe("Ran code");
    expect(row.summary).toBe("search, browser.screenshot");
  });
});
