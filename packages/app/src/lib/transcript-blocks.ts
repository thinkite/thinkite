import type { TimelineItem, ToolCallDetail } from "@sidecodeapp/protocol";

/**
 * Annotate `TimelineItem[]` (already-normalized stream from daemon) with
 * "render hints" the FlatList rows need: a stable id and an
 * `isFirstOfRoleRun` / `showRoleHeader` flag for collapsing same-speaker
 * runs into one continuous turn.
 *
 * Pairing tool_use+tool_result, flattening ContentBlock[], computing per-tool
 * summaries — all that lives in the daemon now (Slice D, see
 * daemon/src/messages/normalize.ts). This module is purely a render-side
 * speaker state machine.
 */

export type RenderBlock = TextRenderBlock | ToolRenderBlock;

export interface TextRenderBlock {
  kind: "text";
  /** Stable key for FlatList. `<itemUuid>:<itemIndex>`. */
  id: string;
  role: "user" | "assistant";
  text: string;
  /**
   * Renderer drops the role header when false. Computed by a "current
   * speaker" state machine: text re-asserts the role only when the
   * speaker actually changes. A `[CLAUDE text → tools → CLAUDE summary]`
   * sequence is one turn — only the first text shows "CLAUDE".
   */
  isFirstOfRoleRun: boolean;
}

export interface ToolRenderBlock {
  kind: "tool";
  id: string;
  /** Anthropic tool_use id (preserved from the wire `callId`). */
  callId: string;
  /** Raw SDK tool name (e.g. "Bash", "Edit", "WebFetch"). */
  name: string;
  /** Daemon-computed chip label — basename, command summary, "5/12 todos", etc. */
  summary: string;
  status: "completed" | "failed";
  /** Server-computed structured detail; ToolBlock dispatches on `detail.type`. */
  detail: ToolCallDetail;
  /**
   * True when this is the first tool of an assistant turn that wasn't
   * already opened by an assistant text. Renderer shows a "CLAUDE" header
   * above the chip so the tool's attribution is unambiguous (otherwise it
   * looks like the tool is hanging off the previous user message).
   */
  showRoleHeader: boolean;
}

export function flattenToBlocks(items: readonly TimelineItem[]): RenderBlock[] {
  const out: RenderBlock[] = [];
  // "Speaker" state machine: who currently has the floor. Text/tool blocks
  // attach their role header only on speaker transitions.
  let speaker: "user" | "assistant" | null = null;

  items.forEach((item, idx) => {
    switch (item.type) {
      case "user_message": {
        out.push({
          kind: "text",
          id: `${item.uuid}:${idx}`,
          role: "user",
          text: item.text,
          isFirstOfRoleRun: speaker !== "user",
        });
        speaker = "user";
        return;
      }
      case "assistant_message": {
        out.push({
          kind: "text",
          id: `${item.uuid}:${idx}`,
          role: "assistant",
          text: item.text,
          isFirstOfRoleRun: speaker !== "assistant",
        });
        speaker = "assistant";
        return;
      }
      case "tool_call": {
        out.push({
          kind: "tool",
          id: `${item.callId}:${idx}`,
          callId: item.callId,
          name: item.name,
          summary: item.summary,
          status: item.status,
          detail: item.detail,
          // Tools always belong to the assistant. Show CLAUDE header only when
          // the speaker isn't already assistant — i.e. when the tool kicks off
          // a turn that an assistant text block hadn't already opened.
          showRoleHeader: speaker !== "assistant",
        });
        speaker = "assistant";
        return;
      }
    }
  });

  return out;
}
