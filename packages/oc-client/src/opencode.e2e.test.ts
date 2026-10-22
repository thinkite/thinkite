/**
 * Gated live E2E against the user's registered opencode 2 service
 * (`~/.local/state/opencode/service.json`). Run with:
 *
 *   THINKITE_E2E_OPENCODE=1 bunx vitest run packages/oc-client/src/opencode.e2e.test.ts
 *
 * Creates a scratch session in a temp directory, sends one prompt through
 * the store, waits for the turn to end, asserts the transcript settled onto
 * the projection, and deletes the session. `MODEL=provider/id` picks the
 * model (default: a free one).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOcClient } from "./client.ts";
import { parseModelRef } from "./model-ref.ts";
import { createOcStore } from "./store/store.ts";

const enabled = process.env.THINKITE_E2E_OPENCODE === "1";

describe.skipIf(!enabled)("opencode 2 live", () => {
  it("creates, prompts, settles and deletes a session", async () => {
    const state =
      process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
    const registry = JSON.parse(
      await readFile(join(state, "opencode", "service.json"), "utf8"),
    ) as {
      url: string;
      password: string;
    };
    const client = createOcClient({
      baseUrl: registry.url,
      password: registry.password,
    });
    expect((await client.info()).version).toMatch(/^2\./);

    const dir = await mkdtemp(join(tmpdir(), "thinkite-e2e-"));
    const store = createOcStore({ client });
    try {
      await store.start();
      const session = await store.createSession({
        directory: dir,
        model: parseModelRef(
          process.env.MODEL ?? "opencode/deepseek-v4.1-flash-free",
        ),
      });
      expect(store.rootSessions.get().map((s) => s.id)).toContain(session.id);

      await store.prompt(session.id, "Reply with exactly: pong");
      const rows = () => store.session.message.get()[session.id] ?? [];
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const last = rows().at(-1);
        if (!store.running.get().has(session.id) && last?.type === "idle")
          break;
        await new Promise((r) => setTimeout(r, 250));
      }
      store.flush();

      // Settled: the tail read after execution.succeeded merged the server rows.
      expect(rows().map((r) => r.type)).toEqual(["user", "assistant", "idle"]);
      const assistant = rows()[1];
      expect(assistant?.type === "assistant" ? assistant.finish : null).toBe(
        "stop",
      );
      expect(
        assistant?.type === "assistant"
          ? assistant.content.find((c) => c.type === "text")?.text.trim()
          : null,
      ).toBe("pong");
      const projection = await client.listMessages(session.id, { limit: 10 });
      expect(rows()).toMatchObject(projection.messages.slice().reverse());

      await client.deleteSession(session.id);
      const gone = Date.now() + 5000;
      while (
        Date.now() < gone &&
        store.session.info.get()[session.id] !== undefined
      ) {
        await new Promise((r) => setTimeout(r, 100));
        store.flush();
      }
      expect(store.session.info.get()[session.id]).toBeUndefined();
    } finally {
      store.stop();
      await rm(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
