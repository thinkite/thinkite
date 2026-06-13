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

  it("drops interrupt markers (string + text-block forms), keeps real messages", () => {
    // The CLI writes these synthetic markers into the JSONL on interrupt;
    // the live stream never emits them, so dropping on cold-read keeps the
    // transcript consistent. Both content shapes the SDK may surface.
    const out = normalize([
      userMsg("u-1", "[Request interrupted by user]"),
      userMsg("u-2", [
        { type: "text", text: "[Request interrupted by user for tool use]" },
      ]),
      userMsg("u-3", "real follow-up"),
    ]);
    expect(out).toEqual([
      { type: "user_message", uuid: "u-3", text: "real follow-up" },
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

  it("extracts error text from array-form tool_result.content", () => {
    // Anthropic spec lets tool_result.content be either `string` or
    // `[{type:"text", text:"..."}, ...]`. Edit/Read failures often arrive in
    // the array form. Daemon should extract a flat string so iOS doesn't
    // re-implement ContentBlock parsing.
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "Edit",
          input: {
            file_path: "/abs/foo.ts",
            old_string: "missing",
            new_string: "x",
          },
        },
      ]),
      userMsg("u-1", [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: [
            { type: "text", text: "String to replace not found in file." },
          ],
          is_error: true,
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    expect(item.status).toBe("failed");
    expect(item.error).toBe("String to replace not found in file.");
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

  it("Edit unifiedDiff is hunk-only (`@@ ... @@\\n+/-/space lines`) with no Index/===/---/+++ preamble", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "Edit",
          input: {
            file_path: "/abs/foo.ts",
            old_string: "old",
            new_string: "new",
          },
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    if (item.detail.type !== "edit") throw new Error("expected edit detail");
    expect(item.detail.unifiedDiff.startsWith("@@")).toBe(true);
    expect(item.detail.unifiedDiff).not.toContain("Index:");
    expect(item.detail.unifiedDiff).not.toContain("===");
    expect(item.detail.unifiedDiff).not.toContain("--- ");
    expect(item.detail.unifiedDiff).not.toContain("+++ ");
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
    // NotebookEdit is one of the Tier-3 tools deliberately left in the
    // unknown bucket for V0 (low frequency, no specific iOS render).
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "NotebookEdit",
          input: {
            notebook_path: "/x.ipynb",
            cell_id: "c1",
            new_source: "print(2)",
          },
        },
      ]),
      userMsg("u-1", [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "Updated cell c1.",
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    expect(item.summary).toBe("NotebookEdit");
    if (item.detail.type !== "unknown")
      throw new Error("expected unknown detail");
    expect(item.detail.toolName).toBe("NotebookEdit");
    expect(item.detail.output).toBe("Updated cell c1.");
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
    expect(out).toEqual([{ type: "user_message", uuid: "u-1", text: "hi" }]);
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

// ─── Phase 2: image attachments / stopReason / new tool variants ──────

function assistantMsgWithStop(
  uuid: string,
  content: unknown[],
  stopReason: string | null,
): SessionMessage {
  return {
    type: "assistant",
    uuid,
    session_id: "test-session",
    message: { role: "assistant", content, stop_reason: stopReason },
    parent_tool_use_id: null,
  };
}

describe("normalize — user message images", () => {
  it("collapses image + text content blocks into one user_message item", () => {
    const out = normalize([
      userMsg("u-1", [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: "/9j/4AAQ...",
          },
        },
        { type: "text", text: "What does this say?" },
      ]),
    ]);
    expect(out).toHaveLength(1);
    const item = out[0];
    if (item?.type !== "user_message") throw new Error("expected user_message");
    expect(item.text).toBe("What does this say?");
    expect(item.images).toEqual([
      { data: "/9j/4AAQ...", mediaType: "image/jpeg" },
    ]);
  });

  it("emits user_message with images only (empty text) when user sends just images", () => {
    const out = normalize([
      userMsg("u-1", [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0...",
          },
        },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/jpeg",
            data: "/9j/4AAQ...",
          },
        },
      ]),
    ]);
    expect(out).toHaveLength(1);
    const item = out[0];
    if (item?.type !== "user_message") throw new Error("expected user_message");
    expect(item.text).toBe("");
    expect(item.images).toHaveLength(2);
    expect(item.images?.[0]?.mediaType).toBe("image/png");
    expect(item.images?.[1]?.mediaType).toBe("image/jpeg");
  });

  it("drops unsupported image media types (gif/webp/heic) silently", () => {
    const out = normalize([
      userMsg("u-1", [
        { type: "text", text: "look" },
        {
          type: "image",
          source: { type: "base64", media_type: "image/gif", data: "R0lG..." },
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "user_message") throw new Error("expected user_message");
    expect(item.text).toBe("look");
    // gif filtered out — UI gets only the text
    expect(item.images).toBeUndefined();
  });

  it("drops URL-source images (V0 only supports inline base64)", () => {
    const out = normalize([
      userMsg("u-1", [
        { type: "text", text: "see remote img" },
        {
          type: "image",
          source: { type: "url", url: "https://example.com/x.png" },
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "user_message") throw new Error("expected user_message");
    expect(item.images).toBeUndefined();
  });
});

describe("normalize — assistant stopReason", () => {
  it("carries stop_reason from envelope onto each assistant_message item", () => {
    const out = normalize([
      assistantMsgWithStop(
        "a-1",
        [{ type: "text", text: "done." }],
        "end_turn",
      ),
    ]);
    const item = out[0];
    if (item?.type !== "assistant_message")
      throw new Error("expected assistant_message");
    expect(item.stopReason).toBe("end_turn");
  });

  it("encodes user-interrupted as stopReason=null", () => {
    const out = normalize([
      assistantMsgWithStop(
        "a-1",
        [{ type: "text", text: "(stopped...)" }],
        null,
      ),
    ]);
    const item = out[0];
    if (item?.type !== "assistant_message")
      throw new Error("expected assistant_message");
    expect(item.stopReason).toBeNull();
  });

  it("leaves stopReason undefined when envelope has no stop_reason field", () => {
    const out = normalize([
      assistantMsg("a-1", [{ type: "text", text: "hi" }]),
    ]);
    const item = out[0];
    if (item?.type !== "assistant_message")
      throw new Error("expected assistant_message");
    expect(item.stopReason).toBeUndefined();
  });

  it("rejects unknown stop_reason strings (zod safeParse → undefined)", () => {
    const out = normalize([
      assistantMsgWithStop(
        "a-1",
        [{ type: "text", text: "x" }],
        "garbage_value",
      ),
    ]);
    const item = out[0];
    if (item?.type !== "assistant_message")
      throw new Error("expected assistant_message");
    // Bad enum → safeParse fails → falls back to undefined (defensive)
    expect(item.stopReason).toBeUndefined();
  });
});

describe("normalize — new tool variants", () => {
  function detectAndPair(name: string, input: unknown, resultText: string) {
    const out = normalize([
      assistantMsg("a-1", [{ type: "tool_use", id: "tu-1", name, input }]),
      userMsg("u-1", [
        { type: "tool_result", tool_use_id: "tu-1", content: resultText },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    return item;
  }

  it("Agent → agent variant with subagentType + description + output", () => {
    const item = detectAndPair(
      "Agent",
      {
        subagent_type: "Explore",
        description: "Search code",
        prompt: "Find X",
      },
      "Found X at src/foo.ts:42",
    );
    if (item.detail.type !== "agent") throw new Error("expected agent");
    expect(item.detail.subagentType).toBe("Explore");
    expect(item.detail.description).toBe("Search code");
    expect(item.detail.output).toBe("Found X at src/foo.ts:42");
    expect(item.summary).toBe("Explore: Search code");
  });

  it("Agent with explicit model override → '(model)' in summary", () => {
    const item = detectAndPair(
      "Agent",
      {
        subagent_type: "Explore",
        description: "Search code",
        prompt: "Find X",
        model: "haiku",
      },
      "done",
    );
    if (item.detail.type !== "agent") throw new Error("expected agent");
    expect(item.detail.model).toBe("haiku");
    expect(item.summary).toBe("Explore (haiku): Search code");
  });

  it("Agent without subagent_type (SDK optional) → bare description summary", () => {
    const item = detectAndPair(
      "Agent",
      { description: "Search code", prompt: "Find X" },
      "done",
    );
    if (item.detail.type !== "agent") throw new Error("expected agent");
    expect(item.detail.subagentType).toBe("");
    expect(item.summary).toBe("Search code");
  });

  it("WebFetch → web_fetch variant with host-only summary", () => {
    const item = detectAndPair(
      "WebFetch",
      { url: "https://docs.anthropic.com/some/path", prompt: "extract X" },
      "the extracted X",
    );
    if (item.detail.type !== "web_fetch") throw new Error("expected web_fetch");
    expect(item.detail.url).toBe("https://docs.anthropic.com/some/path");
    expect(item.summary).toBe("docs.anthropic.com");
  });

  it("WebSearch → web_search variant", () => {
    const item = detectAndPair(
      "WebSearch",
      { query: "react native keyboard controller" },
      "1. Title - URL\n2. Title - URL",
    );
    if (item.detail.type !== "web_search")
      throw new Error("expected web_search");
    expect(item.detail.query).toBe("react native keyboard controller");
    expect(item.summary).toBe('"react native keyboard controller"');
  });

  it("TaskCreate → parses taskId from tool_result text", () => {
    const item = detectAndPair(
      "TaskCreate",
      {
        subject: "Install react-qrcode-logo",
        description: "Add it to package.json",
        activeForm: "Installing",
      },
      "Task #1 created successfully: Install react-qrcode-logo",
    );
    if (item.detail.type !== "task_create")
      throw new Error("expected task_create");
    expect(item.detail.taskId).toBe("1");
    expect(item.detail.subject).toBe("Install react-qrcode-logo");
  });

  it("TaskUpdate → carries taskId + status from input verbatim", () => {
    const item = detectAndPair(
      "TaskUpdate",
      { taskId: "3", status: "in_progress" },
      "Updated task #3 status",
    );
    if (item.detail.type !== "task_update")
      throw new Error("expected task_update");
    expect(item.detail.taskId).toBe("3");
    expect(item.detail.status).toBe("in_progress");
  });

  it("TaskStop → normalizes SDK snake_case task_id to camelCase taskId", () => {
    const item = detectAndPair(
      "TaskStop",
      { task_id: "b3v2ethee" },
      "Task stopped.",
    );
    if (item.detail.type !== "task_stop") throw new Error("expected task_stop");
    expect(item.detail.taskId).toBe("b3v2ethee");
    // Object-only — the iOS row prepends "Stopped task".
    expect(item.summary).toBe("#b3v2ethee");
  });

  it("AskUserQuestion → parses answers[] from tool_result", () => {
    const item = detectAndPair(
      "AskUserQuestion",
      {
        questions: [
          {
            question: "What font?",
            header: "Font choice",
            multiSelect: false,
            options: [
              { label: "Inter", description: "Sans-serif" },
              { label: "JetBrains Mono", description: "Mono" },
            ],
          },
        ],
      },
      'User has answered your questions: "What font?"="Inter". You can now continue.',
    );
    if (item.detail.type !== "ask_user") throw new Error("expected ask_user");
    expect(item.detail.questions).toHaveLength(1);
    expect(item.detail.answers).toEqual(["Inter"]);
    expect(item.summary).toBe("Font choice");
  });

  it("ScheduleWakeup → schedule_wakeup variant with delay + reason + prompt", () => {
    const item = detectAndPair(
      "ScheduleWakeup",
      {
        delaySeconds: 90,
        reason: "check menubar dev boot",
        prompt: "Read /tmp/...",
      },
      "Next wakeup scheduled for 04:20:00 (in 90s).",
    );
    if (item.detail.type !== "schedule_wakeup")
      throw new Error("expected schedule_wakeup");
    expect(item.detail.delaySeconds).toBe(90);
    expect(item.summary).toBe("+90s · check menubar dev boot");
  });
});

describe("normalize — bash run_in_background", () => {
  it("carries runInBackground + parses taskId from SDK confirmation text", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "Bash",
          input: {
            command: "pnpm dev",
            description: "Start dev server",
            run_in_background: true,
          },
        },
      ]),
      userMsg("u-1", [
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content:
            "Command running in background with ID: b3v2ethee. Output is being written to: /tmp/.../tasks/b3v2ethee.output. You will be notified when it completes.",
        },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call") throw new Error("expected tool_call");
    if (item.detail.type !== "bash") throw new Error("expected bash");
    expect(item.detail.runInBackground).toBe(true);
    expect(item.detail.taskId).toBe("b3v2ethee");
  });

  it("non-background Bash leaves runInBackground undefined", () => {
    const out = normalize([
      assistantMsg("a-1", [
        {
          type: "tool_use",
          id: "tu-1",
          name: "Bash",
          input: { command: "ls" },
        },
      ]),
      userMsg("u-1", [
        { type: "tool_result", tool_use_id: "tu-1", content: "file.txt\n" },
      ]),
    ]);
    const item = out[0];
    if (item?.type !== "tool_call" || item.detail.type !== "bash")
      throw new Error("expected bash");
    expect(item.detail.runInBackground).toBeUndefined();
    expect(item.detail.taskId).toBeUndefined();
  });
});

describe("normalize — system messages dropped", () => {
  it("drops system messages entirely (SDK strips subtype/metadata anyway)", () => {
    // V0 trade documented in normalize.ts: getSessionMessages's AH
    // mapper strips `subtype` + `compactMetadata` from any system
    // message it returns, so we can't tell a compact_boundary apart
    // from a stop_hook_summary. Dropping all system messages keeps the
    // output deterministic; live path renders the compact divider
    // separately via run-query.ts (which sees the typed SDKCompactBoundaryMessage).
    const sys = {
      type: "system",
      uuid: "sys-1",
      session_id: "test-session",
    } as unknown as SessionMessage;
    expect(normalize([sys, userMsg("u-1", "hi")])).toEqual([
      { type: "user_message", uuid: "u-1", text: "hi" },
    ]);
  });
});
