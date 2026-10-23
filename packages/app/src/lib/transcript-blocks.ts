import {
  type PromptFile,
  type SessionMessageInfo,
  toolDiffs,
  toolOutput,
  toolSummary,
} from "@thinkite/oc-client";

/**
 * Turn opencode's transcript (`SessionMessageInfo` rows, oldest first) into
 * the flat rows the list renders: one row per text part and one per tool
 * call, each with a stable id, so the row components dispatch on `kind`
 * without re-discriminating the protocol union.
 */

/** An image sent with a prompt: base64 bytes plus their media type. */
export interface ImageAttachment {
  data: string;
  mediaType: string;
}

/** Picked images as prompt files: inline data URIs the service stores as-is. */
export function toPromptFiles(
  images: readonly ImageAttachment[] | undefined,
): PromptFile[] {
  return (images ?? []).map((image, i) => ({
    uri: `data:${image.mediaType};base64,${image.data}`,
    name: `image-${i + 1}.${image.mediaType.split("/")[1] ?? "jpg"}`,
  }));
}

export type RenderBlock = TextRenderBlock | ToolRenderBlock | NoteRenderBlock;

export interface TextRenderBlock {
  kind: "text";
  /** Stable list key: `<messageId>:<partIndex>`. */
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Images on a user message, in the order they were picked. The render
   *  layer materializes them to `file://` URIs via `image-cache.ts` —
   *  Galeria's native iOS viewer can't decode `data:` URIs directly. */
  images?: ImageAttachment[];
}

export interface ToolRenderBlock {
  kind: "tool";
  id: string;
  /** opencode's tool call id. */
  callId: string;
  /** opencode tool name (`bash`, `edit`, `read`, …). */
  name: string;
  /** Row object label — a path, command or pattern. Rendered after the verb. */
  summary: string;
  status: "completed" | "failed" | "running";
  /** Tool error text when `status === "failed"`, null otherwise. */
  error: string | null;
  /** What the shared tool sheet shows; it dispatches on `detail.type`. */
  detail: ToolDetail;
}

/** A one-line system notice: compaction, a model or agent switch, a failed turn. */
export interface NoteRenderBlock {
  kind: "note";
  id: string;
  text: string;
}

/** The tool sheet's view of a call, per family of opencode's built-in tools. */
export type ToolDetail =
  | { type: "bash"; command: string; description?: string; output: string }
  | { type: "read"; filePath: string; content: string }
  | { type: "edit"; filePath: string; unifiedDiff: string }
  | { type: "write"; filePath: string; unifiedDiff: string }
  | { type: "grep"; pattern: string; path?: string; output: string }
  | { type: "glob"; pattern: string; path?: string; output: string }
  | {
      type: "agent";
      subagentType: string;
      description: string;
      prompt: string;
      output: string;
    }
  | { type: "web_fetch"; url: string; output: string }
  | { type: "web_search"; query: string; output: string }
  | {
      type: "question";
      /** Each question with its short header and the answer given (empty
       *  until answered, or when left unanswered). */
      questions: { header: string; question: string; answer: string[] }[];
      /** Waiting on the user; the prompt card is up. */
      waiting: boolean;
      /** The user dismissed it (the card's ×) rather than answering. */
      dismissed: boolean;
    }
  | { type: "unknown"; toolName: string; input: unknown; output: string };

type AssistantMessage = Extract<SessionMessageInfo, { type: "assistant" }>;
type ToolItem = Extract<AssistantMessage["content"][number], { type: "tool" }>;

const STATUS = {
  streaming: "running",
  running: "running",
  completed: "completed",
  error: "failed",
} as const;

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

function toolDetail(tool: ToolItem): ToolDetail {
  const raw = tool.state.input;
  const input: Record<string, unknown> =
    raw !== null && typeof raw === "object"
      ? (raw as Record<string, unknown>)
      : {};
  const output = toolOutput(tool);
  const filePath = text(input.filePath) || text(input.path);
  switch (tool.name) {
    case "bash":
      return {
        type: "bash",
        command: text(input.command),
        ...(text(input.description)
          ? { description: text(input.description) }
          : {}),
        output,
      };
    case "read":
      return { type: "read", filePath, content: output };
    case "edit":
    case "write":
    case "apply_patch":
    case "patch":
      return {
        type: tool.name === "write" ? "write" : "edit",
        filePath,
        unifiedDiff: toolDiffs(tool)
          .map((d) => d.patch)
          .join("\n"),
      };
    case "grep":
    case "glob":
      return {
        type: tool.name,
        pattern: text(input.pattern),
        ...(text(input.path) ? { path: text(input.path) } : {}),
        output,
      };
    case "task":
      return {
        type: "agent",
        subagentType: text(input.subagent_type),
        description: text(input.description),
        prompt: text(input.prompt),
        output,
      };
    case "webfetch":
      return { type: "web_fetch", url: text(input.url), output };
    case "websearch":
      return { type: "web_search", query: text(input.query), output };
    case "question":
      return questionDetail(tool, input);
    default:
      return { type: "unknown", toolName: tool.name, input: raw, output };
  }
}

/** The question tool's questions and answers: its input lists the
 *  questions, its metadata the answers in the same order. A dismissal ends
 *  it as an "aborted" error. */
function questionDetail(
  tool: ToolItem,
  input: Record<string, unknown>,
): ToolDetail {
  const state = tool.state as {
    status: string;
    metadata?: { answers?: unknown };
    error?: { type?: string };
  };
  const answers = Array.isArray(state.metadata?.answers)
    ? state.metadata.answers
    : [];
  const asked = Array.isArray(input.questions) ? input.questions : [];
  return {
    type: "question",
    questions: asked.map((q: Record<string, unknown>, i) => {
      const answer: unknown = answers[i];
      return {
        header: text(q?.header),
        question: text(q?.question),
        answer: Array.isArray(answer) ? answer.map(String) : [],
      };
    }),
    waiting: state.status === "running" || state.status === "streaming",
    dismissed: state.status === "error" && state.error?.type === "aborted",
  };
}

/** A question's row after opencode's app: "Color · Red", "Pets ·
 *  Dismissed", "Answered 2 questions"; the verb (toolVerb) is the muted
 *  part and this the rest. */
function questionSummary(detail: ToolDetail): string {
  if (detail.type !== "question" || detail.waiting) return "";
  if (detail.dismissed) return "· Dismissed";
  const [only] = detail.questions;
  if (detail.questions.length !== 1 || only === undefined) return "";
  return `· ${only.answer.join(", ") || "Unanswered"}`;
}

/** A failed call, which its row shows in red. A dismissed question isn't
 *  one: the user chose not to answer. */
export function isToolError(block: ToolRenderBlock): boolean {
  return (
    block.status === "failed" &&
    !(block.detail.type === "question" && block.detail.dismissed)
  );
}

function toolBlock(tool: ToolItem, id: string): ToolRenderBlock {
  const detail = toolDetail(tool);
  return {
    kind: "tool",
    id,
    callId: tool.id,
    name: tool.name,
    summary:
      detail.type === "question" ? questionSummary(detail) : toolSummary(tool),
    status: STATUS[tool.state.status],
    error: tool.state.status === "error" ? tool.state.error.message : null,
    detail,
  };
}

function images(message: SessionMessageInfo): ImageAttachment[] | undefined {
  if (message.type !== "user" || message.files === undefined) return undefined;
  const out = message.files.flatMap((f) =>
    "data" in f && typeof f.data === "string" && f.mime.startsWith("image/")
      ? [{ data: f.data, mediaType: f.mime }]
      : [],
  );
  return out.length > 0 ? out : undefined;
}

export function flattenToBlocks(
  messages: readonly SessionMessageInfo[],
): RenderBlock[] {
  const blocks: RenderBlock[] = [];
  const note = (id: string, value: string) =>
    blocks.push({ kind: "note", id, text: value });
  for (const message of messages) {
    switch (message.type) {
      case "user":
        blocks.push({
          kind: "text",
          id: `${message.id}:0`,
          role: "user",
          text: message.text,
          ...(images(message) ? { images: images(message) } : {}),
        });
        break;
      case "assistant":
        message.content.forEach((item, index) => {
          const id = `${message.id}:${index}`;
          if (item.type === "text") {
            if (item.text !== "")
              blocks.push({
                kind: "text",
                id,
                role: "assistant",
                text: item.text,
              });
          } else if (item.type === "tool") {
            blocks.push(toolBlock(item, id));
          }
          // Reasoning stays hidden on the phone.
        });
        if (message.error !== undefined)
          note(`${message.id}:error`, message.error.message);
        break;
      case "compaction":
        note(
          message.id,
          message.status === "running"
            ? "Compacting context…"
            : "Context compacted",
        );
        break;
      case "agent-switched":
        note(message.id, `Agent: ${message.agent}`);
        break;
      case "shell":
        note(message.id, `$ ${message.command}`);
        break;
      // Turn boundaries, model switches (the composer shows the model) and
      // other service-side notes the phone does not show.
      default:
        break;
    }
  }
  return blocks;
}
