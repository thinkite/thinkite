/**
 * Re-record the `src/opencode/__fixtures__/*.json` event logs from a live
 * `opencode serve` (opencode 1.18.30).
 *
 *   bun scripts/record-opencode-fixtures.ts <projectDir>
 *
 * Runs three scenarios (text turn, tool turn, interrupted turn) against a
 * cheap model, saving the durable `session.next.*` logs verbatim. Scrub
 * home paths / tokens from the output before committing. Compaction has no
 * live source (`POST compact` is 503 in this version) — its fixture stays
 * synthetic (see `__fixtures__/compaction-turn.json`).
 *
 * Uses the ambient opencode integration state for credentials (same as the
 * daemon host); `THINKITE_OPENCODE_API_KEY` is passed through when set.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const PROJECT = process.argv[2];
if (!PROJECT) {
  console.error("usage: bun scripts/record-opencode-fixtures.ts <projectDir>");
  process.exit(1);
}
const MODEL = {
  providerID: process.env.OC_PROVIDER ?? "opencode-go",
  id: process.env.OC_MODEL ?? "deepseek-v4.1-flash",
};
const FIXTURES = new URL("../src/opencode/__fixtures__/", import.meta.url);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      s.close(() =>
        resolve(typeof addr === "object" && addr !== null ? addr.port : 0),
      );
    });
  });
}

const username = "opencode";
const password = randomBytes(16).toString("hex");
const port = await freePort();
const env: Record<string, string | undefined> = {
  ...process.env,
  OPENCODE_SERVER_USERNAME: username,
  OPENCODE_SERVER_PASSWORD: password,
  OPENCODE_CLIENT: "thinkite",
};
if (process.env.THINKITE_OPENCODE_API_KEY !== undefined) {
  env.OPENCODE_API_KEY = process.env.THINKITE_OPENCODE_API_KEY;
}
const child = spawn(
  "opencode",
  ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
  {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const stop = async (): Promise<void> => {
  child.kill("SIGTERM");
  setTimeout(() => child.kill("SIGKILL"), 5000);
  await new Promise((r) => child.once("exit", r));
};

try {
  const base = await new Promise<URL>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error("no listening line")),
      30_000,
    );
    child.stdout?.on("data", (c: Buffer) => {
      buf += String(c);
      const m = buf.match(/listening on (http:\/\/[^\s]+)/);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve(new URL(m[1]));
      }
    });
    child.once("exit", (code) => reject(new Error(`exited: ${code}`)));
  });
  const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const H = { authorization: auth, "content-type": "application/json" };
  for (let i = 0; i < 100; i++) {
    const r = await fetch(new URL("/global/health", base), {
      headers: { authorization: auth },
    }).catch(() => null);
    if (r?.ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  async function runScenario(
    name: string,
    promptText: string,
    interruptAfterMs?: number,
  ): Promise<void> {
    const created = (await (
      await fetch(new URL("/api/session", base), {
        method: "POST",
        headers: H,
        body: JSON.stringify({
          location: { directory: PROJECT },
          model: MODEL,
        }),
      })
    ).json()) as { data: { id: string } };
    const sid = created.data.id;
    const seen: unknown[] = [];
    const ctrl = new AbortController();
    const stream = fetch(new URL(`/api/session/${sid}/event?after=0`, base), {
      headers: { ...H, accept: "text/event-stream" },
      signal: ctrl.signal,
    }).then(async (r) => {
      const reader = r.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let idx = buf.indexOf("\n\n");
        while (idx >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = block
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (data) seen.push(JSON.parse(data));
          idx = buf.indexOf("\n\n");
        }
      }
    });
    await new Promise((r) => setTimeout(r, 300));
    await fetch(new URL(`/api/session/${sid}/prompt`, base), {
      method: "POST",
      headers: H,
      body: JSON.stringify({ prompt: { text: promptText } }),
    });
    if (interruptAfterMs !== undefined) {
      await new Promise((r) => setTimeout(r, interruptAfterMs));
      await fetch(new URL(`/api/session/${sid}/interrupt`, base), {
        method: "POST",
        headers: H,
      });
      await new Promise((r) => setTimeout(r, 8000));
    } else {
      let last = -1;
      let quiet = 0;
      for (let i = 0; i < 150 && quiet < 8; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        if (seen.length !== last) {
          last = seen.length;
          quiet = 0;
        } else {
          quiet += 1;
        }
      }
    }
    ctrl.abort();
    await stream.catch(() => {});
    writeFileSync(
      path.join(FIXTURES.pathname, `${name}.json`),
      `${JSON.stringify(seen, null, 1)}\n`,
    );
    console.log(`${name}.json: ${seen.length} events`);
  }

  await runScenario(
    "text-turn",
    "Reply with exactly the word pong and nothing else.",
  );
  await runScenario(
    "tools-turn",
    "Run `echo hello-tools` with the bash tool, then read the file package.json (first 5 lines), then reply with exactly: done",
  );
  await runScenario(
    "interrupted-turn",
    "Write a long story about a robot, at least 500 words, take your time.",
    8000,
  );
} finally {
  await stop();
}
