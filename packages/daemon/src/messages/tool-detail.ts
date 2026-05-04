/**
 * Building blocks shared between batch normalize (`normalize.ts`) and the
 * incremental query runner (`runtime/run-query.ts`):
 *
 *   - Anthropic ContentBlock zod schemas (text/tool_use/tool_result + the
 *     per-role discriminated unions)
 *   - Per-tool input schemas (Bash, Read, Edit, Write, TodoWrite, Grep, Glob)
 *   - `buildDetailFromInput(name, rawInput)`: maps SDK tool_use into a typed
 *     `ToolCallDetail` variant, with a fallback `unknown` for tools we don't
 *     specially-render in V0
 *   - `attachOutputToDetail(detail, outputText)`: in-place plug of a textual
 *     tool_result into whichever field of the variant holds it
 *   - `summaryFor(detail, name)`: chip-label string the iOS row renders
 *   - `extractText(raw)`: pull text from a `tool_result.content` (string or
 *     ContentBlock[])
 *
 * F2's incremental runner needs the same primitives the batch normalize does
 * — pulling them here keeps single-source-of-truth, so a fix to (say) Edit's
 * unifiedDiff format only touches one place.
 */

import {
  grepMode,
  type ToolCallDetail,
  todoEntry,
} from "@sidecodeapp/protocol";
import { structuredPatch } from "diff";
import { z } from "zod";
import { detectLanguageForPath } from "./language-detect.js";

// ─── Anthropic ContentBlock schemas ─────────────────────────────────────

export const textBlock = z.object({
  type: z.literal("text"),
  text: z.string(),
});

export const toolUseBlock = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});

export const toolResultBlock = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional().default(false),
});

export const assistantContentBlock = z.discriminatedUnion("type", [
  textBlock,
  toolUseBlock,
]);

export const userContentBlock = z.discriminatedUnion("type", [
  textBlock,
  toolResultBlock,
]);

// ─── Per-tool input schemas ─────────────────────────────────────────────
//
// Mirror the SDK's `ToolInputSchemas` shape but only the fields we surface.
// Failed parse → fallback to `unknown` variant (defensive: malformed
// Claude output never crashes normalization).

const bashInputSchema = z.object({
  command: z.string(),
  description: z.string().optional(),
});

const readInputSchema = z.object({
  file_path: z.string(),
  offset: z.number().optional(),
  limit: z.number().optional(),
  pages: z.string().optional(),
});

const editInputSchema = z.object({
  file_path: z.string(),
  old_string: z.string(),
  new_string: z.string(),
  replace_all: z.boolean().optional(),
});

const writeInputSchema = z.object({
  file_path: z.string(),
  content: z.string(),
});

const todoInputSchema = z.object({
  todos: z.array(todoEntry),
});

const grepInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  output_mode: grepMode.optional(),
});

const globInputSchema = z.object({
  pattern: z.string(),
  path: z.string().optional(),
});

// ─── Detail builder ─────────────────────────────────────────────────────

export function buildDetailFromInput(
  name: string,
  rawInput: unknown,
): ToolCallDetail {
  switch (name) {
    case "Bash": {
      const parsed = bashInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { command, description } = parsed.data;
      return {
        type: "bash",
        command,
        description,
        output: "", // populated by tool_result attachment
      };
    }

    case "Read":
    case "FileRead": {
      const parsed = readInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { file_path, offset, limit, pages } = parsed.data;
      return {
        type: "read",
        filePath: file_path,
        content: "", // populated by tool_result attachment
        language: detectLanguageForPath(file_path),
        offset,
        limit,
        pages,
      };
    }

    case "Edit":
    case "FileEdit": {
      const parsed = editInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { file_path, old_string, new_string, replace_all } = parsed.data;
      return {
        type: "edit",
        filePath: file_path,
        oldString: old_string,
        newString: new_string,
        replaceAll: replace_all,
        unifiedDiff: makeUnifiedDiff(file_path, old_string, new_string),
      };
    }

    case "Write":
    case "FileWrite": {
      const parsed = writeInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { file_path, content } = parsed.data;
      return {
        type: "write",
        filePath: file_path,
        content,
        // Treat every Write as create-from-empty — we lack the prior file
        // content (sidecar stripped by getSessionMessages), so an "update"
        // diff isn't reconstructible. The all-green new-file diff is still
        // the right visual: shows what was written.
        unifiedDiff: makeUnifiedDiff(file_path, "", content),
      };
    }

    case "TodoWrite": {
      const parsed = todoInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      return { type: "todo", todos: parsed.data.todos };
    }

    case "Grep": {
      const parsed = grepInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { pattern, path, output_mode } = parsed.data;
      return {
        type: "grep",
        pattern,
        path,
        // SDK default per GrepInput docs.
        mode: output_mode ?? "files_with_matches",
        output: "", // populated by tool_result attachment
      };
    }

    case "Glob": {
      const parsed = globInputSchema.safeParse(rawInput);
      if (!parsed.success) return unknownDetail(name, rawInput);
      const { pattern, path } = parsed.data;
      return {
        type: "glob",
        pattern,
        path,
        output: "", // populated by tool_result attachment
      };
    }

    default:
      return unknownDetail(name, rawInput);
  }
}

function unknownDetail(name: string, rawInput: unknown): ToolCallDetail {
  return { type: "unknown", toolName: name, input: rawInput, output: "" };
}

/**
 * Compose a clean unified-diff string of just `@@...@@` hunks, ready for
 * MarkdownView's auto-detect diff renderer (no fence needed iOS-side).
 *
 * We use jsdiff's `structuredPatch` rather than `createPatch` to skip the
 * full-file boilerplate (`Index:`, `===`, `--- file`, `+++ file`) that:
 *   - CommonMark would otherwise mis-parse (`Index: foo\n====` becomes a
 *     setext h1; `+`-prefixed lines become bullet lists)
 *   - is cosmetic noise — MarkdownView's diff render already shows the
 *     filename in the chip / accordion summary; repeating the path in a
 *     `--- /Users/.../file` row above every diff is redundant.
 *
 * Output for a small Edit:
 *   @@ -1,3 +1,3 @@
 *   -const x = 1;
 *   +const x = 2;
 *    const y = 3;
 *
 * Empty oldString === newString produces an empty string (no hunks).
 */
function makeUnifiedDiff(
  filePath: string,
  oldString: string,
  newString: string,
): string {
  const patch = structuredPatch(filePath, filePath, oldString, newString);
  return patch.hunks
    .map(
      (h) =>
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n` +
        h.lines.join("\n"),
    )
    .join("\n");
}

/**
 * Plug textual tool_result output into whichever field of the detail
 * variant carries it (varies per type — bash.output, read.content, etc.).
 * Mutates `detail` in place.
 */
export function attachOutputToDetail(
  detail: ToolCallDetail,
  output: string,
): void {
  switch (detail.type) {
    case "bash":
      detail.output = output;
      return;
    case "read":
      detail.content = stripLineNumberPrefix(output);
      return;
    case "grep":
    case "glob":
    case "unknown":
      detail.output = output;
      return;
    // edit/write/todo don't surface tool_result text — input is sufficient.
    case "edit":
    case "write":
    case "todo":
      return;
  }
}

// ─── Summary (chip label) ───────────────────────────────────────────────

export function summaryFor(detail: ToolCallDetail, name: string): string {
  switch (detail.type) {
    case "bash":
      return detail.description || truncate(detail.command, 60);
    case "read":
    case "edit":
    case "write":
      return basenameOf(detail.filePath);
    case "todo": {
      const total = detail.todos.length;
      const done = detail.todos.filter((t) => t.status === "completed").length;
      return `${done}/${total} todos`;
    }
    case "grep":
      return detail.path
        ? `"${detail.pattern}" in ${basenameOf(detail.path)}`
        : `"${detail.pattern}"`;
    case "glob":
      return detail.pattern;
    case "unknown":
      return name;
  }
}

// ─── Small helpers ──────────────────────────────────────────────────────

/**
 * Pull text from a tool_result.content field. Anthropic spec allows either
 * a string or an array of `{ type: "text", text: string }` (and image/etc.
 * blocks we don't surface in V0).
 */
export function extractText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  const parts: string[] = [];
  for (const b of raw) {
    const parsed = textBlock.safeParse(b);
    if (parsed.success) parts.push(parsed.data.text);
  }
  return parts.join("");
}

/**
 * Strip Claude Code's `<right-justified line number>\t` prefix from Read
 * tool output. Only strips when EVERY non-empty line matches, to avoid
 * mangling content that happens to start with digits + tab.
 */
function stripLineNumberPrefix(text: string): string {
  if (text.length === 0) return text;
  const lines = text.split("\n");
  const re = /^\s*\d+\t/;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (!re.test(line)) return text;
  }
  return lines.map((l) => (l.length === 0 ? "" : l.replace(re, ""))).join("\n");
}

function basenameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
