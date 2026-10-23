import type { ToolDetail } from "@/lib/transcript-blocks";

/**
 * Past-tense verb for a tool-call row: `<verb> <summary>` where the verb is
 * muted (red on failure) and the summary is the object ("Read
 * chat-markdown.tsx", "Searched <pattern>", "Ran agent explore").
 *
 * Vocabulary harvested from claude.ai/code (2026-06-12, live probe):
 * Read / Ran / Searched / Created / Edited / Searched web / Fetched /
 * Ran agent / Used <name>. Failure keeps the verb — only the color flips.
 * `running` rows also render past tense by design (no -ing forms): the
 * web's progressive labels swap mid-turn, which reads as flicker in a
 * virtualized list, and the row settles within a couple hundred ms anyway.
 */
export function toolVerb(detail: ToolDetail): string {
  switch (detail.type) {
    case "bash":
      return "Ran";
    case "read":
      return "Read";
    case "edit":
      return "Edited";
    case "write":
      return "Created";
    case "grep":
    case "glob":
      return "Searched";
    case "agent":
      return "Ran agent";
    case "web_fetch":
      return "Fetched";
    case "web_search":
      return "Searched web";
    // The question tool reads as opencode's app has it: the question's
    // header before its answer (transcript-blocks' questionSummary).
    case "question": {
      if (detail.waiting) return "Needs your input";
      const [only] = detail.questions;
      if (detail.questions.length === 1 && only !== undefined)
        return only.header || "Question";
      return detail.dismissed
        ? "Questions"
        : `Answered ${detail.questions.length} questions`;
    }
    case "unknown":
      return `Used ${detail.toolName}`;
  }
}
