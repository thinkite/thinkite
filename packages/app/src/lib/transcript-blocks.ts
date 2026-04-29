/**
 * Flatten `SessionMessage[]` (wire shape from daemon's getMessages) into a
 * heterogeneous list of "render blocks" that the FlatList iterates.
 *
 * Tool pairing: a `tool_use` block (in an assistant message) is paired with
 * its `tool_result` block (in the next user message) by `tool_use_id`. We
 * fold the result into the same render block, so the renderer doesn't have
 * to look it up. Tool_results never produce their own render block — they
 * vanish into their tool_use's payload.
 *
 * V0 scope: text + tool blocks. `thinking` / `redacted_thinking` /
 * `image` blocks are silently dropped. Unknown block shapes are dropped
 * — corrupt transcript should never white-screen the detail page.
 *
 * A user message whose content is entirely tool_results emits zero render
 * blocks (results consumed upstream, no human-typed text to show). This is
 * intentional — those "messages" are runtime injection, not user speech.
 */

export type RenderBlock = TextRenderBlock | ToolRenderBlock;

export interface TextRenderBlock {
  kind: "text";
  /** Stable key for FlatList. `<sessionMessageUuid>:<contentBlockIndex>`. */
  id: string;
  role: "user" | "assistant";
  text: string;
}

export interface ToolRenderBlock {
  kind: "tool";
  id: string;
  /** The Anthropic tool_use id, used to pair with tool_result on the wire. */
  toolUseId: string;
  /** Tool name, e.g. "Read", "Bash", "Edit". Display as-is. */
  name: string;
  /** Raw input object, tool-specific shape. Renderer may pretty-print or
   *  pull a single field for a chip summary. */
  input: unknown;
  /** Paired tool_result. `undefined` means the result hasn't landed yet —
   *  legitimately happens for the trailing tool_use of an in-flight or
   *  interrupted session. */
  result?: { content: string; isError: boolean };
}

interface RawSessionMessage {
  type: "user" | "assistant" | "system";
  uuid: string;
  message: unknown;
}

interface RawApiMessage {
  role?: unknown;
  content?: unknown;
}

interface RawTextBlock {
  type: "text";
  text: string;
}

interface RawToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface RawToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}

export function flattenToBlocks(messages: unknown[]): RenderBlock[] {
  // Pass 1: collect all tool_results so the second pass can attach them
  // to their tool_use synchronously. Pass-2-only would force lookahead.
  const resultByToolUseId = new Map<string, ToolRenderBlock["result"]>();
  for (const raw of messages) {
    if (!isSessionMessage(raw)) continue;
    const content = (raw.message as RawApiMessage | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isToolResultBlock(block)) continue;
      resultByToolUseId.set(block.tool_use_id, {
        content: normalizeToolResultContent(block.content),
        isError: block.is_error === true,
      });
    }
  }

  const out: RenderBlock[] = [];
  for (const raw of messages) {
    if (!isSessionMessage(raw)) continue;
    if (raw.type === "system") continue;
    const role: "user" | "assistant" = raw.type;
    const content = (raw.message as RawApiMessage | undefined)?.content;

    if (typeof content === "string") {
      if (content.trim().length > 0) {
        out.push({ kind: "text", id: `${raw.uuid}:0`, role, text: content });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;

    content.forEach((block, i) => {
      if (isTextBlock(block)) {
        if (block.text.trim().length === 0) return;
        out.push({
          kind: "text",
          id: `${raw.uuid}:${i}`,
          role,
          text: block.text,
        });
      } else if (isToolUseBlock(block)) {
        out.push({
          kind: "tool",
          id: `${raw.uuid}:${i}`,
          toolUseId: block.id,
          name: block.name,
          input: block.input,
          result: resultByToolUseId.get(block.id),
        });
      }
      // tool_result, thinking, redacted_thinking, image: silently dropped
    });
  }
  return out;
}

/**
 * Tool result content can be a plain string OR an array of `{type:"text",
 * text}` blocks (Anthropic API supports mixed). We always present a single
 * string to renderers — they don't care about block boundaries.
 */
function normalizeToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (isTextBlock(b) ? b.text : ""))
      .filter((s) => s.length > 0)
      .join("\n");
  }
  // Image-only or unknown shape: stringify so we still show something.
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

function isSessionMessage(v: unknown): v is RawSessionMessage {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.uuid === "string" &&
    (o.type === "user" || o.type === "assistant" || o.type === "system")
  );
}

function isTextBlock(v: unknown): v is RawTextBlock {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.type === "text" && typeof o.text === "string";
}

function isToolUseBlock(v: unknown): v is RawToolUseBlock {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    o.type === "tool_use" &&
    typeof o.id === "string" &&
    typeof o.name === "string"
  );
}

function isToolResultBlock(v: unknown): v is RawToolResultBlock {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o.type === "tool_result" && typeof o.tool_use_id === "string";
}

/**
 * Short, one-line summary for an Accordion trigger. Pulls a well-known
 * field from `input` based on tool name. Falls back to empty string —
 * the caller (trigger row) shows the chip + name even without summary.
 */
export function summarizeToolInput(name: string, input: unknown): string {
  if (input == null || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const str = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : "");
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return str("file_path");
    case "Bash":
      return str("description") || truncate(str("command"), 60);
    case "Grep":
      return str("pattern")
        ? `"${str("pattern")}"${str("path") ? ` in ${str("path")}` : ""}`
        : "";
    case "Glob":
      return str("pattern");
    case "WebFetch": {
      const url = str("url");
      if (!url) return "";
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    }
    case "WebSearch":
      return str("query");
    case "TodoWrite":
      return Array.isArray(i.todos) ? `${i.todos.length} todos` : "";
    case "Task":
    case "Agent":
      return str("description");
    default:
      return "";
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
