/**
 * End-to-end: what the sidebar shows of a session's agent — waiting on a
 * permission request or a question (its own or a subagent's), failed, and a
 * finished turn the user has not looked at — read by the store from a real
 * opencode 2 service of its own (see `isolated-service.e2e.ts`). The turns
 * run on one of OpenCode's free models, which need no sign-in; the failure
 * comes from a model the provider doesn't have.
 *
 * Model replies vary, so each prompt names the one tool it must use and the
 * waits are generous. Gated by `THINKITE_E2E_AGENT=1`; needs `opencode`
 * (≥ 2.1) on PATH and network access:
 *
 *   THINKITE_E2E_AGENT=1 bunx vitest run packages/oc-client/src/agent-state.e2e.test.ts
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type IsolatedService,
  startIsolatedService,
} from "./isolated-service.e2e.ts";
import { createOcStore, isUnread, type OcStore } from "./store/store.ts";

const runIf = process.env.THINKITE_E2E_AGENT === "1" ? describe : describe.skip;

const FREE = { providerID: "opencode", id: "deepseek-v4.1-flash-free" };
const TURN = 180_000;

async function until<T>(
  read: () => T | undefined,
  what: string,
  ms = TURN,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what}`);
}

runIf("agent state (isolated service, free model)", () => {
  let service: IsolatedService;
  let store: OcStore;

  beforeAll(async () => {
    service = await startIsolatedService("oc-agent-e2e-");
    // Reading .env files is the one thing build asks before doing.
    writeFileSync(join(service.dir, ".env.local"), "THINKITE_E2E=granted\n");
    store = createOcStore({ client: service.client, onError: () => {} });
    await store.start();
  }, 40_000);

  afterAll(() => {
    store?.stop();
    service?.stop();
  });

  const session = (model = FREE) =>
    store.createSession({ directory: service.dir, model });
  const idle = (id: string) => (store.running.get().has(id) ? undefined : true);

  it(
    "waits on a permission request, then reads as an unread reply",
    async () => {
      const s = await session();
      await store.prompt(
        s.id,
        "Use the read tool to read the file .env.local in this directory, then tell me its contents.",
      );
      const request = await until(
        () => store.pending.get()[s.id]?.permissions[0],
        "a permission request",
      );
      expect(request.sessionID).toBe(s.id);
      await store.replyPermission(request, "once");
      await until(
        () => (store.pending.get()[s.id] ? undefined : true),
        "the answer",
      );
      await until(() => idle(s.id), "the turn to end");
      const row = await until(() => {
        const r = store.session.info.get()[s.id];
        return r?.time.idle !== undefined ? r : undefined;
      }, "the finished turn on the row");
      expect(isUnread(row)).toBe(true);

      store.markViewed(s.id);
      const fresh = await service.client.getSession(s.id);
      expect(fresh.time.viewed).toBe(row.time.idle);
      expect(isUnread(fresh)).toBe(false);
    },
    TURN * 2,
  );

  it(
    "waits on a question",
    async () => {
      const s = await session();
      await store.prompt(
        s.id,
        "Use the question tool to ask me whether I prefer A or B. Do not answer it yourself.",
      );
      const form = await until(
        () => store.pending.get()[s.id]?.forms[0],
        "a question",
      );
      await store.cancelForm(form);
      await until(
        () => (store.pending.get()[s.id] ? undefined : true),
        "the cancel",
      );
    },
    TURN * 2,
  );

  it(
    "files a subagent's permission request under the session that started it",
    async () => {
      const s = await session();
      await store.prompt(
        s.id,
        "Use the task tool to start a general subagent, and have it use the read tool on the file .env.local in this directory. Do not read it yourself.",
      );
      const request = await until(
        () => store.pending.get()[s.id]?.permissions[0],
        "the subagent's permission request",
      );
      expect(request.sessionID).not.toBe(s.id);
      expect(store.session.info.get()[request.sessionID]?.parentID).toBe(s.id);
      // A rejected read only sends the agent looking for another way in;
      // stop the turn instead of waiting it out.
      await store.replyPermission(request, "reject");
      await service.client.interrupt(s.id);
      await until(() => idle(s.id), "the turn to stop", 60_000);
    },
    TURN * 2,
  );

  it("flags a turn that failed", async () => {
    const s = await session({ providerID: "opencode", id: "no-such-model" });
    await store.prompt(s.id, "Say hi.");
    await until(
      () => store.session.failed.get()[s.id],
      "the turn to fail",
      60_000,
    );
  }, 90_000);
});
