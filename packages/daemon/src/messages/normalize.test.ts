import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { normalize } from "./normalize.js";

// Tiny helper to build SDK-shaped messages without typing 5 fields each time.
function userMsg(uuid: string, content: unknown): SessionMessage {
  return {
    type: "user",
    uuid,
    session_id: "test-session",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

function assistantMsg(uuid: string, content: unknown[]): SessionMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "test-session",
    message: { role: "assistant", content },
    parent_tool_use_id: null,
  };
}

describe("normalize", () => {
  it("emits user_message for plain string user content", () => {
    const out = normalize([userMsg("u-1", "hello there")]);
    expect(out).toEqual([
      { type: "user_message", uuid: "u-1", text: "hello there" },
    ]);
  });

  it("emits assistant_message for text blocks; ignores thinking blocks", () => {
    const out = normalize([
      assistantMsg("a-1", [
        { type: "thinking", thinking: "internal", signature: "sig" },
        { type: "text", text: "Here is the plan." },
      ]),
    ]);
    expect(out).toEqual([
      { type: "assistant_message", uuid: "a-1", text: "Here is the plan." },
    ]);
  });

  it("skips empty text blocks (post-streaming sometimes leaves empty fragments)", () => {
    const out = normalize([
      userMsg("u-1", ""),
      assistantMsg("a-1", [{ type: "text", text: "" }]),
    ]);
    expect(out).toEqual([]);
  });

  it("pairs Bash tool_use + tool_result into a single tool_call", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-bash-1",
          name: "Bash",
          input: { command: "ls", description: "List files in current dir" },
        },
      ]),
      userMsg("u-1", [
        {
          type: "tool_result",
          tool_use_id: "tu-bash-1",
          content: "file1.txt\nfile2.txt\n",
        },
      ]),
    ]);
    expect(out).toHaveLength(1);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    expect(item.name).toBe("Bash");
    expect(item.callId).toBe("tu-bash-1");
    expect(item.summary).toBe("List files in current dir");
    expect(item.status).toBe("completed");
    if (item.detail.type !== "bash") throw new Error("expected bash detail");
    expect(item.detail.command).toBe("ls");
    expect(item.detail.output).toBe("file1.txt\nfile2.txt\n");
  });

  it("Bash falls back to truncated command when description is missing", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "Bash",
          input: { command: "echo hello world" },
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    expect(item.summary).toBe("echo hello world");
  });

  it("flips status to failed when tool_result.is_error is true", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "Bash",
          input: { command: "false" },
        },
      ]),
      userMsg("u-1", [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "exit code 1",
          is_error: true,
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    expect(item.status).toBe("failed");
    expect(item.error).toBe("exit code 1");
  });

  it("Edit produces a unified diff via jsdiff", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "Edit",
          input: {
            file_path: "/abs/foo.ts",
            old_string: "const x = 1;",
            new_string: "const x = 2;",
          },
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    if (item.detail.type !== "edit") throw new Error("expected edit detail");
    expect(item.detail.filePath).toBe("/abs/foo.ts");
    expect(item.detail.unifiedDiff).toContain("@@");
    expect(item.detail.unifiedDiff).toContain("-const x = 1;");
    expect(item.detail.unifiedDiff).toContain("+const x = 2;");
    expect(item.summary).toBe("foo.ts");
  });

  it("Write produces an all-add diff against empty (we lack prior content)", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "Write",
          input: {
            file_path: "/abs/new.txt",
            content: "line one\nline two\n",
          },
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    if (item.detail.type !== "write") throw new Error("expected write detail");
    expect(item.detail.unifiedDiff).toContain("+line one");
    expect(item.detail.unifiedDiff).toContain("+line two");
    expect(item.detail.unifiedDiff).not.toContain("-line");
  });

  it("Read strips the line-number prefix from the model-visible content", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "Read",
          input: { file_path: "/abs/util.py" },
        },
      ]),
      userMsg("u-1", [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: [
            {
              type: "text",
              text: "     1\timport os\n     2\t\n     3\tprint(os.cwd())\n",
            },
          ],
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    if (item.detail.type !== "read") throw new Error("expected read detail");
    expect(item.detail.content).toBe("import os\n\nprint(os.cwd())\n");
    expect(item.detail.language).toBe("python");
  });

  it("TodoWrite summary counts done/total", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "TodoWrite",
          input: {
            todos: [
              { content: "A", status: "completed", activeForm: "A-ing" },
              { content: "B", status: "completed", activeForm: "B-ing" },
              { content: "C", status: "in_progress", activeForm: "C-ing" },
              { content: "D", status: "pending", activeForm: "D-ing" },
            ],
          },
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    expect(item.summary).toBe("2/4 todos");
    if (item.detail.type !== "todo") throw new Error("expected todo detail");
    expect(item.detail.todos).toHaveLength(4);
    expect(item.detail.todos[2]?.status).toBe("in_progress");
  });

  it("Grep summary embeds the pattern + basename of path", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "Grep",
          input: {
            pattern: "TODO",
            path: "/abs/repo/src",
            output_mode: "content",
          },
        },
      ]),
      userMsg("u-1", [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "src/foo.ts:12:// TODO: refactor\n",
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    expect(item.summary).toBe('"TODO" in src');
    if (item.detail.type !== "grep") throw new Error("expected grep detail");
    expect(item.detail.mode).toBe("content");
    expect(item.detail.output).toContain("TODO: refactor");
  });

  it("Falls back to unknown for tools we don't specially-render", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "WebFetch",
          input: { url: "https://example.com", prompt: "summary" },
        },
      ]),
      userMsg("u-1", [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "Page summary text…",
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    expect(item.summary).toBe("WebFetch");
    if (item.detail.type !== "unknown")
      throw new Error("expected unknown detail");
    expect(item.detail.toolName).toBe("WebFetch");
    expect(item.detail.output).toBe("Page summary text…");
  });

  it("Drops orphan tool_results (no prior tool_use with that id)", () => {
    const out = normalize([
      userMsg("u-1", [
        {
          type: "tool_result",
          tool_use_id: "tu-orphan",
          content: "...",
        },
      ]),
    ]);
    expect(out).toEqual([]);
  });

  it("Skips system messages entirely", () => {
    const out = normalize([
      {
        type: "system",
        uuid: "s-1",
        session_id: "test",
        message: { role: "system", content: "boot prompt" },
        parent_tool_use_id: null,
      },
      userMsg("u-1", "hi"),
    ]);
    expect(out).toEqual([
      { type: "user_message", uuid: "u-1", text: "hi" },
    ]);
  });

  it("Preserves order across mixed text + tool_use within one assistant turn", () => {
    const out = normalize([
      assistantMsg("a-1", [
        { type: "text", text: "Let me check the file." },
        {
          type: "tool_use",
          id: "tu-1",
          name: "Read",
          input: { file_path: "/x.ts" },
        },
        { type: "text", text: "Here's what I found:" },
      ]),
    ]);
    expect(out.map((i) => i.type)).toEqual([
      "assistant_message",
      "tool_call",
      "assistant_message",
    ]);
  });
});
