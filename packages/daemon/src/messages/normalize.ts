import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type TimelineItem,
  type ToolCallItem,
} from "@sidecodeapp/protocol";
import {
  assistantContentBlock,
  attachOutputToDetail,
  buildDetailFromInput,
  extractText,
  summaryFor,
  userContentBlock,
} from "./tool-detail.js";

/**
 * Convert SDK `SessionMessage[]` (raw Anthropic message envelopes) into a
 * flat `TimelineItem[]` for iOS. This is sidecode's batch normalization
 * layer used on cold-start: assistant text becomes its own item,
 * tool_use+tool_result are paired into a single ToolCallItem with
 * status/error, and per-tool detail variants carry the bits iOS needs to
 * render a typed UI (vs raw JSON).
 *
 * For incremental streaming during a live turn, see runtime/run-query.ts —
 * it emits `EventDelta`s into a SessionRuntime instead of building a full
 * array. The two paths share `tool-detail.ts` so detail formatting stays
 * consistent.
 *
 * Reality check: `getSessionMessages()` strips the JSONL sidecar
 * `toolUseResult` field (verified empirically), so we only have:
 *   - tool_use input (typed, useful)
 *   - tool_result.content as text (the model's view; no exit codes,
 *     no structured patches, no numFiles)
 *
 * For Edit/Write we therefore compute unified diffs via jsdiff from the
 * input strings — Edit diffs the snippet old→new, Write diffs empty→content
 * (so every Write renders as a green all-add new-file diff).
 */
export function normalize(messages: readonly SessionMessage[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  const pendingByCallId = new Map<string, ToolCallItem>();

  for (const sdkMsg of messages) {
    if (sdkMsg.type === "system") continue;
    const env = sdkMsg.message;
    if (typeof env !== "object" || env === null) continue;
    const content = (env as { content?: unknown }).content;

    if (sdkMsg.type === "user") {
      // user.content is `string | ContentBlock[]`. Plain string → single user_message.
      if (typeof content === "string") {
        if (content.length > 0) {
          out.push({ type: "user_message", uuid: sdkMsg.uuid, text: content });
        }
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        const parsedBlock = userContentBlock.safeParse(block);
        if (!parsedBlock.success) continue;
        const b = parsedBlock.data;
        if (b.type === "text") {
          if (b.text.length > 0) {
            out.push({
              type: "user_message",
              uuid: sdkMsg.uuid,
              text: b.text,
            });
          }
        } else {
          // tool_result
          const target = pendingByCallId.get(b.tool_use_id);
          if (target === undefined) continue; // orphan result, skip
          const outputText = extractText(b.content);
          target.status = b.is_error ? "failed" : "completed";
          // Anthropic tool_result.content is `string | ContentBlock[]`; the
          // array form (e.g. `[{type:"text", text:"..."}]`) shows up for some
          // tools. Always store extracted text so iOS doesn't re-implement
          // ContentBlock parsing just to display an error string.
          target.error = b.is_error ? outputText : null;
          attachOutputToDetail(target.detail, outputText);
        }
      }
      continue;
    }

    // sdkMsg.type === "assistant"
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const parsedBlock = assistantContentBlock.safeParse(block);
      if (!parsedBlock.success) continue; // includes "thinking" etc — ignored
      const b = parsedBlock.data;
      if (b.type === "text") {
        if (b.text.length > 0) {
          out.push({
            type: "assistant_message",
            uuid: sdkMsg.uuid,
            text: b.text,
          });
        }
      } else {
        // tool_use
        const detail = buildDetailFromInput(b.name, b.input);
        const item: ToolCallItem = {
          type: "tool_call",
          callId: b.id,
          name: b.name,
          summary: summaryFor(detail, b.name),
          // Default to completed; later tool_result may flip to failed.
          // Tools without a matching tool_result stay "completed" — V0 reads
          // settled JSONL so missing-result is rare and the tool likely just
          // ran with no payload (e.g. silent success).
          status: "completed",
          error: null,
          detail,
        };
        out.push(item);
        pendingByCallId.set(b.id, item);
      }
    }
  }

  return out;
}
