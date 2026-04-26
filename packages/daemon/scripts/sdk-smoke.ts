// SDK smoke test — independent of daemon code.
// Verifies the surface we'll wrap in W1: query() iteration, canUseTool round-trip,
// interrupt(), streamInput(), and listSessions().
//
// Costs ~$0.001-0.01 per run on user's Claude Code auth (~/.claude/).
// Run from repo root: pnpm --filter @sidecodeapp/daemon exec tsx scripts/sdk-smoke.ts

import {
  type CanUseTool,
  type PermissionResult,
  query,
  type SDKMessage,
  type SDKUserMessage,
  listSessions,
} from "@anthropic-ai/claude-agent-sdk";

const log = (...args: unknown[]) => console.log("[smoke]", ...args);

const canUseTool: CanUseTool = async (toolName, input, ctx): Promise<PermissionResult> => {
  log(`canUseTool fired: tool=${toolName} title=${ctx.title ?? "—"} toolUseID=${ctx.toolUseID}`);
  log(`  input=${JSON.stringify(input).slice(0, 120)}`);
  // Allow Read but deny anything else, just to see both branches working.
  if (toolName === "Read") return { behavior: "allow" };
  return { behavior: "deny", message: "smoke-test: only Read allowed" };
};

async function summarizeStream(q: AsyncGenerator<SDKMessage, void>): Promise<void> {
  let n = 0;
  for await (const msg of q) {
    n += 1;
    const tag = `${n.toString().padStart(2, "0")} ${msg.type}`;
    if (msg.type === "assistant") {
      const text = msg.message.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join(" ")
        .slice(0, 80);
      log(tag, `→ "${text}"`);
    } else if (msg.type === "result") {
      log(
        tag,
        msg.subtype === "success"
          ? `cost=$${msg.total_cost_usd.toFixed(4)} turns=${msg.num_turns} dur=${msg.duration_ms}ms`
          : `error subtype=${msg.subtype}`,
      );
    } else {
      log(tag);
    }
  }
}

async function test1_simpleQuery(): Promise<void> {
  log("=== test 1: simple query, no tools ===");
  const q = query({
    prompt: "Reply with exactly one word: hi",
    options: { canUseTool, enableFileCheckpointing: true },
  });
  await summarizeStream(q);
}

async function test2_toolUseTriggersCanUseTool(): Promise<void> {
  log("=== test 2: prompt that should trigger Read tool ===");
  const q = query({
    prompt: `Read the file at ${process.cwd()}/package.json and tell me its "name" field. Use the Read tool.`,
    options: { canUseTool, enableFileCheckpointing: true },
  });
  await summarizeStream(q);
}

async function test3_listSessions(): Promise<void> {
  log("=== test 3: listSessions ===");
  const sessions = await listSessions({ dir: process.cwd() });
  log(`got ${sessions.length} sessions in ${process.cwd()}`);
  for (const s of sessions.slice(0, 3)) {
    log(`  ${s.sessionId.slice(0, 8)}… "${s.summary.slice(0, 60)}" mtime=${new Date(s.lastModified).toISOString()}`);
  }
}

async function test4_streamInputAndInterrupt(): Promise<void> {
  log("=== test 4: streaming input + interrupt mid-turn ===");
  // Build an AsyncIterable<SDKUserMessage> we can push to.
  let resolveNext: ((v: SDKUserMessage | null) => void) | null = null;
  const queue: SDKUserMessage[] = [];
  const stream: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]: async function* () {
      while (true) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        const v = await new Promise<SDKUserMessage | null>((r) => {
          resolveNext = r;
        });
        if (v === null) return;
        yield v;
      }
    },
  };
  const push = (text: string) => {
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: "",
    };
    if (resolveNext) {
      resolveNext(msg);
      resolveNext = null;
    } else {
      queue.push(msg);
    }
  };
  const close = () => {
    if (resolveNext) {
      resolveNext(null);
      resolveNext = null;
    }
  };

  push("Count slowly from 1 to 30, one number per line.");
  const q = query({ prompt: stream, options: { canUseTool } });

  // Interrupt after first assistant token.
  let interrupted = false;
  setTimeout(async () => {
    log("→ calling interrupt()");
    await q.interrupt();
    interrupted = true;
    close();
  }, 1500);

  try {
    await summarizeStream(q);
  } catch (err) {
    log("stream threw (expected on interrupt):", (err as Error).message);
  }
  log(`interrupt actually fired: ${interrupted}`);
}

async function main(): Promise<void> {
  const tests: Array<[string, () => Promise<void>]> = [
    ["simple", test1_simpleQuery],
    ["toolUse", test2_toolUseTriggersCanUseTool],
    ["listSessions", test3_listSessions],
    ["streamInput", test4_streamInputAndInterrupt],
  ];
  const only = process.argv.slice(2);
  for (const [name, fn] of tests) {
    if (only.length && !only.includes(name)) continue;
    try {
      await fn();
    } catch (err) {
      log(`FAILED ${name}:`, err);
    }
    log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
