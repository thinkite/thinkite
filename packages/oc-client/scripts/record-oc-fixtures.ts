#!/usr/bin/env bun
/**
 * Record reducer fixtures from a running opencode 2 service.
 *
 * Discovers the service from the opencode registry
 * (`~/.local/state/opencode/service.json`), creates a scratch session in a
 * temp directory, runs two turns — a plain reply and one `read` tool call —
 * while capturing every bus event addressed to the session, then reads the
 * final `message.list` projection and deletes the session.
 *
 * Output: `src/__fixtures__/<name>.json` as `{ events, messages }`. The
 * reducer test folds `events` and expects the streaming subset to equal the
 * projection (see transcript-reducer.test.ts for what is compared).
 *
 * Usage: bun scripts/record-oc-fixtures.ts [outDir]
 * `MODEL=provider/id` picks the model (default: a free one).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCode, type OpenCodeEvent } from "@opencode/client";

const outDir =
  process.argv[2] ?? new URL("../src/__fixtures__/", import.meta.url).pathname;
const state = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
const registry = JSON.parse(
  await readFile(join(state, "opencode", "service.json"), "utf8"),
) as {
  url: string;
  password: string;
};
const client = OpenCode.make({
  baseUrl: registry.url,
  headers: { authorization: `Basic ${btoa(`opencode:${registry.password}`)}` },
});
const info = await client.server.info();
console.log("service", info.version);
const [providerID, ...rest] = (
  process.env.MODEL ?? "opencode/deepseek-v4.1-flash-free"
).split("/");

const dir = await mkdtemp(join(tmpdir(), "thinkite-oc-fixture-"));
await writeFile(join(dir, "hello.txt"), "thinkite fixture 42\n");
const session = await client.session.create({
  location: { directory: dir },
  title: "thinkite fixture",
  model: { providerID: providerID as string, id: rest.join("/") },
});
console.log("session", session.id);

const captured: OpenCodeEvent[] = [];
const bus = new AbortController();
const turnEnd: { resolve: (() => void) | null } = { resolve: null };
const busDone = (async () => {
  try {
    for await (const event of client.event.subscribe({ signal: bus.signal })) {
      const data = (event as { data?: { sessionID?: string } }).data;
      if (data?.sessionID !== session.id) continue;
      captured.push(event);
      if (
        event.type.startsWith("session.execution.") &&
        event.type !== "session.execution.started"
      )
        turnEnd.resolve?.();
    }
  } catch {
    // aborted
  }
})();
await new Promise((r) => setTimeout(r, 200));

async function turn(name: string, text: string) {
  const before = captured.length;
  const finished = new Promise<void>((resolve) => {
    turnEnd.resolve = resolve;
  });
  await client.session.prompt({ sessionID: session.id, text });
  await Promise.race([finished, new Promise((r) => setTimeout(r, 120_000))]);
  turnEnd.resolve = null;
  console.log(name, "events", captured.length - before);
}

await turn("pong", "Reply with exactly: pong");
await turn(
  "read",
  "Use the read tool to read hello.txt in the current directory, then reply with exactly the file contents and nothing else.",
);

// Let trailing usage events land, then read the projection.
await new Promise((r) => setTimeout(r, 500));
bus.abort();
await busDone;
const page = await client.message.list({
  sessionID: session.id,
  limit: 100,
  order: "asc",
});
const fixture = { events: captured, messages: page.data };
const file = join(outDir, "two-turns.json");
await writeFile(file, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  "wrote",
  file,
  "events",
  captured.length,
  "messages",
  page.data.length,
);
console.log("event types", [...new Set(captured.map((e) => e.type))].join(" "));

await client.session.remove({ sessionID: session.id });
await rm(dir, { recursive: true, force: true });
console.log("cleaned up");
