/**
 * Plain helpers that turn a tool part into what a transcript shows: a
 * one-line summary, file diffs (unified patches), and the text output.
 * Field names follow opencode 2.1.2's built-in tools and the official
 * `session-ui` tool renderer.
 */

import type { SessionMessageAssistantTool } from "@opencode/client";

export interface FileDiff {
  file: string;
  patch: string;
  additions: number;
  deletions: number;
}

type Loose = Record<string, unknown>;

function input(tool: SessionMessageAssistantTool): Loose {
  const value = tool.state.input;
  return value && typeof value === "object" ? (value as Loose) : {};
}

function metadata(tool: SessionMessageAssistantTool): Loose {
  const state = tool.state as { metadata?: unknown };
  return state.metadata && typeof state.metadata === "object"
    ? (state.metadata as Loose)
    : {};
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

function shortPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= 3 ? path : `…/${parts.slice(-3).join("/")}`;
}

export function toolSummary(tool: SessionMessageAssistantTool): string {
  if (tool.state.status === "streaming") return "";
  const args = input(tool);
  const path = str(args.filePath) ?? str(args.path);
  const firstLine = (s: string) => s.split("\n", 1)[0] ?? s;
  const summary =
    str(args.description) && tool.name === "task"
      ? str(args.description)
      : str(args.command)
        ? firstLine(str(args.command)!)
        : path
          ? shortPath(path)
          : (str(args.pattern) ??
            str(args.url) ??
            str(args.query) ??
            str(args.description));
  return summary ?? "";
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - Number(text.endsWith("\n"));
}

/** Naive whole-block patch: enough for a preview when the tool reported none. */
function blockPatch(file: string, before: string, after: string): FileDiff {
  const removed = before ? before.replace(/\n$/, "").split("\n") : [];
  const added = after ? after.replace(/\n$/, "").split("\n") : [];
  const patch = [
    `--- a/${file}`,
    `+++ b/${file}`,
    `@@ -1,${removed.length} +1,${added.length} @@`,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
    "",
  ].join("\n");
  return {
    file,
    patch,
    additions: countLines(after),
    deletions: countLines(before),
  };
}

export function toolDiffs(tool: SessionMessageAssistantTool): FileDiff[] {
  const files = metadata(tool).files;
  if (Array.isArray(files)) {
    const out: FileDiff[] = [];
    for (const entry of files) {
      if (!entry || typeof entry !== "object") continue;
      const e = entry as Loose;
      const file = str(e.file);
      const patch = str(e.patch);
      if (!file || !patch) continue;
      out.push({
        file,
        patch,
        additions: typeof e.additions === "number" ? e.additions : 0,
        deletions: typeof e.deletions === "number" ? e.deletions : 0,
      });
    }
    if (out.length > 0) return out;
  }
  if (tool.state.status === "streaming") return [];
  const args = input(tool);
  const path = str(args.filePath) ?? str(args.path);
  if (!path) return [];
  if (
    tool.name === "edit" &&
    typeof args.oldString === "string" &&
    typeof args.newString === "string"
  ) {
    if (args.oldString === args.newString) return [];
    return [blockPatch(path, args.oldString, args.newString)];
  }
  if (tool.name === "write" && typeof args.content === "string") {
    return [blockPatch(path, "", args.content)];
  }
  return [];
}

const MAX_OUTPUT_LINES = 400;

export function toolOutput(tool: SessionMessageAssistantTool): string {
  const state = tool.state as { content?: { type: string; text?: string }[] };
  const meta = metadata(tool);
  const text =
    str(meta.output) ??
    (state.content ?? [])
      .map((part) =>
        part.type === "text" ? (part.text ?? "") : `[${part.type}]`,
      )
      .join("\n");
  const lines = text.split("\n");
  if (lines.length <= MAX_OUTPUT_LINES) return text.replace(/\n+$/, "");
  return `${lines.slice(0, MAX_OUTPUT_LINES).join("\n")}\n… ${lines.length - MAX_OUTPUT_LINES} more lines`;
}
