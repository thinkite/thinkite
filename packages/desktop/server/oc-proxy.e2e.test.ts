/**
 * End-to-end: `@thinkite/oc-client` through the Electron-main `/oc`
 * reverse proxy against the user's registered opencode 2 service — no
 * Electron window, no server of our own.
 *
 * Gated by `THINKITE_E2E_OPENCODE=1` (spends one cheap model turn on the
 * registered service):
 *
 *   THINKITE_E2E_OPENCODE=1 bunx vitest run packages/desktop/server/oc-proxy.e2e.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOcClient, subscribeEvents } from "@thinkite/oc-client";
import { describe, expect, it } from "vitest";
// Source import (not the built dist): keeps this test off the native
// `@number0/iroh` binding the daemon entry pulls in.
import { discoverOpencode } from "../../daemon/src/opencode/registry";
import { handleOcProxy } from "./oc-proxy.ts";

const runIf =
  process.env.THINKITE_E2E_OPENCODE === "1" ? describe : describe.skip;

runIf("oc proxy + client (registered service)", () => {
  it("runs a pong turn through /oc and cleans up", {
    timeout: 180_000,
  }, async () => {
    const upstream = await discoverOpencode();
    if (upstream === null)
      throw new Error("no healthy opencode service registered");
    const dir = mkdtempSync(join(tmpdir(), "oc-proxy-e2e-"));
    let proxy: Server | null = null;
    let sessionId: string | null = null;
    const bus = new AbortController();
    try {
      proxy = createServer((req, res) => handleOcProxy(req, res, upstream));
      const port = await new Promise<number>((resolve) => {
        proxy?.listen(0, "127.0.0.1", () => {
          const addr = proxy?.address();
          resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
        });
      });
      const client = createOcClient({
        baseUrl: `http://127.0.0.1:${port}`,
        pathPrefix: "/oc",
      });
      // Credentials are injected by the proxy: the client sends none.
      expect((await client.health()).pid).toBe(upstream.pid);

      const session = await client.createSession({
        directory: dir,
        title: "oc proxy e2e",
      });
      sessionId = session.id;
      const seen: string[] = [];
      let done: (() => void) | null = null;
      const finished = new Promise<void>((resolve) => {
        done = resolve;
      });
      void subscribeEvents(
        client,
        (event) => {
          const data = (event as { data?: { sessionID?: string } }).data;
          if (data?.sessionID !== session.id) return;
          seen.push(event.type);
          if (event.type === "session.execution.succeeded") done?.();
        },
        { signal: bus.signal },
      );
      await new Promise((r) => setTimeout(r, 200));
      await client.prompt(session.id, "Reply with exactly: pong");
      await Promise.race([
        finished,
        new Promise((r) => setTimeout(r, 120_000)),
      ]);
      expect(seen).toContain("session.execution.started");
      expect(seen).toContain("session.text.delta");
      expect(seen.at(-1)).toBe("session.execution.succeeded");

      const page = await client.listMessages(session.id, { limit: 10 });
      const assistant = page.messages.find((m) => m.type === "assistant");
      expect(assistant?.type).toBe("assistant");
      if (assistant?.type !== "assistant") return;
      expect(
        assistant.content.find((c) => c.type === "text")?.text.trim(),
      ).toBe("pong");

      await client.deleteSession(session.id);
      sessionId = null;
      await client.deleteSession(session.id); // idempotent
    } finally {
      bus.abort();
      if (sessionId !== null) {
        await createOcClient({
          baseUrl: upstream.baseUrl,
          password: upstream.password,
        })
          .deleteSession(sessionId)
          .catch(() => undefined);
      }
      await new Promise<void>((resolve) =>
        proxy ? proxy.close(() => resolve()) : resolve(),
      );
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
