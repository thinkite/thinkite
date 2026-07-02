// Claude session transcripts, read via the agent SDK (same reader the daemon
// uses): `listSessions({dir})` + `getSessionMessages(id, {dir})` — pure JS
// over `~/.claude/projects/<encoded-dir>/*.jsonl`, no claude subprocess.
//
// The SDK is a deno.json dependency (imports map → `npm:`, resolved from
// deno's GLOBAL npm cache — `nodeModulesDir: "none"`). Each runtime declares
// what it consumes: the deno side owns its own deps this way, while pnpm's
// node_modules stays a vite/tsc tooling concern. Global-cache resolution is
// path-independent, so `deno desktop --hmr` (whose modules run out of a
// compile cache dir and can't walk a project node_modules — that broke both
// `npm:`-under-byonm and any hoisted-layout scheme) resolves it fine, and
// the SDK's internal `createRequire` (ajv etc.) resolves inside the cache.
//
// GC note: Claude Code deletes transcripts whose mtime is older than
// `cleanupPeriodDays` (default 30). `listSessions` only returns sessions
// whose JSONL still exists, so "metadata alive, body gone" can't happen here
// — an empty list is the honest state.
import {
  getSessionMessages,
  listSessions,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** One renderable transcript row. Lean on purpose: user/assistant text as
 *  markdown, tool calls as a one-line summary; thinking / tool results /
 *  system noise dropped (slice 1). */
export interface TranscriptRow {
  uuid: string;
  kind: "user" | "assistant" | "tool";
  /** markdown (user/assistant) */
  text?: string;
  tool?: { name: string; summary: string };
  timestamp?: string;
}

/** Compact one-liner for a tool_use input. */
function toolSummary(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const pick =
    o.command ?? o.file_path ?? o.pattern ?? o.query ?? o.url ??
    o.description ?? Object.values(o).find((v) => typeof v === "string");
  const s = typeof pick === "string" ? pick.replace(/\s+/g, " ").trim() : "";
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

/** Local-command echoes, caveats, and other harness-injected user "messages"
 *  that aren't prose. */
function isNoiseText(t: string): boolean {
  const s = t.trimStart();
  return s.startsWith("<") || s.startsWith("Caveat:");
}

function normalize(messages: SessionMessage[]): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const m of messages) {
    // deno-lint-ignore no-explicit-any
    const any = m as any;
    if (any.type !== "user" && any.type !== "assistant") continue;
    const uuid: string = any.uuid ?? crypto.randomUUID();
    const timestamp: string | undefined = any.timestamp;
    const content = any.message?.content;

    if (typeof content === "string") {
      if (any.type === "user" && !isNoiseText(content) && content.trim()) {
        rows.push({ uuid, kind: "user", text: content, timestamp });
      }
      continue;
    }
    if (!Array.isArray(content)) continue;

    let blockIdx = 0;
    for (const block of content) {
      const key = blockIdx === 0 ? uuid : `${uuid}-${blockIdx}`;
      if (block.type === "text" && typeof block.text === "string") {
        if (any.type === "user" && (isNoiseText(block.text) || !block.text.trim())) {
          continue;
        }
        rows.push({
          uuid: key,
          kind: any.type,
          text: block.text,
          timestamp,
        });
        blockIdx++;
      } else if (block.type === "tool_use") {
        rows.push({
          uuid: key,
          kind: "tool",
          tool: { name: block.name ?? "tool", summary: toolSummary(block.input) },
          timestamp,
        });
        blockIdx++;
      }
      // thinking / tool_result / images: dropped in slice 1
    }
  }
  return rows;
}

export async function handleTranscript(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const dir = url.searchParams.get("dir") ?? "";
  if (!dir.startsWith("/")) {
    return new Response("dir must be absolute", { status: 400 });
  }

  if (url.pathname === "/api/claude-sessions") {
    const sessions = await listSessions({ dir });
    return Response.json(
      sessions
        .sort((a, b) => b.lastModified - a.lastModified)
        .map((s) => ({
          id: s.sessionId,
          title: s.summary,
          lastModified: s.lastModified,
          sizeBytes: s.fileSize ?? 0,
        })),
    );
  }

  // /api/transcript?session=<uuid>&dir=<abs>
  const sid = url.searchParams.get("session") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(sid)) {
    return new Response("bad session id", { status: 400 });
  }
  const messages = await getSessionMessages(sid, { dir });
  return Response.json(normalize(messages));
}
