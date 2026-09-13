/**
 * Gated live E2E against the user's registered opencode 2 service
 * (`~/.local/state/opencode/service.json`). Run with:
 *
 *   THINKITE_E2E_OPENCODE=1 bunx vitest run packages/oc-client/src/opencode.e2e.test.ts
 *
 * Creates a scratch session in a temp directory, sends one prompt through
 * the transcript collection, waits for the turn to end, asserts the
 * collection settled onto the projection, and deletes the session.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOcClient } from "./client.ts";
import { mintMessageId } from "./identifier.ts";
import { createSessionsCollection } from "./tanstack/sessions.ts";
import { createTranscriptCollections } from "./tanstack/transcript.ts";

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
    const health = await client.health();
    expect(health.healthy).toBe(true);

    const dir = await mkdtemp(join(tmpdir(), "thinkite-e2e-"));
    const sessions = createSessionsCollection({ client });
    const transcripts = createTranscriptCollections({ client });
    try {
      await sessions.preload();
      const session = await client.createSession({
        directory: dir,
        title: "thinkite e2e",
      });
      const coll = transcripts.get(session.id);
      await coll.preload();

      const id = mintMessageId();
      const tx = transcripts.sendUserMessage({
        sessionId: session.id,
        userMessageUuid: id,
        text: "Reply with exactly: pong",
      });
      await tx.isPersisted.promise;

      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const row = sessions.get(session.id);
        const last = [...coll.values()]
          .sort((a, b) => a.time.created - b.time.created)
          .at(-1);
        if (
          row?.activity === "idle" &&
          last?.type === "assistant" &&
          last.time.completed !== undefined
        )
          break;
        await new Promise((r) => setTimeout(r, 250));
      }
      // Settled: the tail read after execution.succeeded merged the server rows.
      await new Promise((r) => setTimeout(r, 500));
      const rows = [...coll.values()].sort(
        (a, b) => a.time.created - b.time.created,
      );
      expect(rows.map((r) => r.type)).toEqual(["user", "assistant"]);
      expect(rows[0]?.id).toBe(id);
      const assistant = rows[1];
      expect(assistant?.type === "assistant" ? assistant.finish : null).toBe(
        "stop",
      );
      expect(
        assistant?.type === "assistant"
          ? assistant.content.find((c) => c.type === "text")?.text.trim()
          : null,
      ).toBe("pong");
      // Collection rows carry TanStack's virtual `$…` props and the keys the
      // reducer set to undefined; every projection field must match.
      const projection = await client.listMessages(session.id, { limit: 10 });
      expect(rows).toMatchObject(projection.messages.slice().reverse());
      expect(sessions.get(session.id)).toMatchObject({
        title: "thinkite e2e",
        activity: "idle",
      });

      await client.deleteSession(session.id);
      const gone = Date.now() + 5000;
      while (Date.now() < gone && sessions.get(session.id) !== undefined) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(sessions.get(session.id)).toBeUndefined();
    } finally {
      transcripts.disposeAll();
      await sessions.cleanup();
      await rm(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
