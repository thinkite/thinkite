/**
 * End-to-end: `@thinkite/oc-client` through the Electron-main `/oc`
 * reverse proxy against a real `opencode serve` owned by the daemon's
 * `OpencodeHost` — no Electron window.
 *
 * Gated by `THINKITE_E2E_OPENCODE=1` (spawns a real server and spends two
 * cheap model turns). Uses the ambient opencode integration state for
 * credentials, like the daemon host does.
 *
 *   THINKITE_E2E_OPENCODE=1 bunx vitest run packages/desktop/server/oc-proxy.e2e.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOcEvent,
  createInitialTranscriptState,
  createOcClient,
  type OcEventLike,
  type OcTranscriptState,
} from "@thinkite/oc-client";
import { describe, expect, it } from "vitest";
// Source import (not the built dist): keeps this test off the native
// `@number0/iroh` binding the daemon entry pulls in. Extensionless (this
// package's tsconfig does not allow `.ts` specifiers).
import {
  OpencodeHost,
  resolveOpencodeModel,
} from "../../daemon/src/opencode/host";
import { handleOcProxy } from "./oc-proxy.ts";

const runIf =
  process.env.THINKITE_E2E_OPENCODE === "1" ? describe : describe.skip;

async function waitFor(
  label: string,
  check: () => boolean,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

runIf("oc proxy + client (live server)", () => {
  it("streams a pong turn to busy→idle, then records an interrupted turn", {
    timeout: 300_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-stage2-e2e-"));
    const serverLog: string[] = [];
    const host = new OpencodeHost((m) => {
      serverLog.push(m);
    });
    let proxy: Server | null = null;
    const abort = new AbortController();
    const t0 = Date.now();
    const log = (msg: string) =>
      console.log(`[e2e +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
    try {
      log("starting host...");
      const connection = await host.ensureConnection();
      log(`host up at ${connection.baseUrl}`);
      proxy = createServer((req, res) => {
        // Same wiring as the Electron main server (server/index.ts).
        handleOcProxy(req, res, connection);
      });
      await new Promise<void>((r) => proxy!.listen(0, "127.0.0.1", r));
      const port = (proxy.address() as { port: number }).port;
      log(`proxy on ${port}`);
      const client = createOcClient({
        baseUrl: `http://127.0.0.1:${port}/oc`,
      });
      const model = resolveOpencodeModel();
      log(`creating session with ${model.providerID}/${model.id}...`);

      const session = await client.createSession({
        directory: dir,
        model,
      });
      log(`session ${session.id}`);
      expect(session.id.startsWith("ses_")).toBe(true);

      // Fold BOTH the durable session stream and the shared bus through
      // the reducer, exactly like the renderer collections do — including
      // the stream re-open loop: the server ends the session stream
      // shortly after a turn settles, and replay from `lastSeq`
      // converges (observed live).
      let state: OcTranscriptState = createInitialTranscriptState();
      const busTypes: string[] = [];
      const streamTypes: string[] = [];
      const transitions: string[] = [];
      const trackStatus = () => {
        const last = transitions[transitions.length - 1];
        if (last !== state.status) transitions.push(state.status);
      };
      const ingest = (event: OcEventLike) => {
        const next = applyOcEvent(state, event);
        if (next === state) return;
        state = next;
        trackStatus();
      };
      const pump = (async () => {
        const streams = [
          (async () => {
            let backoff = 1000;
            while (!abort.signal.aborted) {
              try {
                for await (const raw of client.openSessionStream(
                  session.id,
                  state.lastSeq,
                  { signal: abort.signal },
                )) {
                  backoff = 1000;
                  const event = raw as unknown as OcEventLike;
                  streamTypes.push(event.type);
                  ingest(event);
                }
                log("session stream ended, re-opening");
              } catch (err) {
                if (abort.signal.aborted) return;
                log(`session stream error: ${err}`);
              }
              await new Promise((r) => setTimeout(r, backoff));
              backoff = Math.min(backoff * 2, 10_000);
            }
          })(),
          (async () => {
            let backoff = 1000;
            while (!abort.signal.aborted) {
              try {
                for await (const raw of client.openEventBus({
                  signal: abort.signal,
                })) {
                  const event = raw as unknown as {
                    type?: string;
                    data?: { sessionID?: string };
                  };
                  if (event.data?.sessionID !== session.id) continue;
                  backoff = 1000;
                  busTypes.push(event.type ?? "?");
                  ingest(event as unknown as OcEventLike);
                }
                log("bus ended, re-opening");
              } catch (err) {
                if (abort.signal.aborted) return;
                log(`bus error: ${err}`);
              }
              await new Promise((r) => setTimeout(r, backoff));
              backoff = Math.min(backoff * 2, 10_000);
            }
          })(),
        ];
        await Promise.all(streams);
      })();
      pump.catch(() => {});

      // Turn 1: exact pong.
      const inputID = `msg_e2e_${Date.now()}`;
      log("prompting...");
      await client.prompt(session.id, "reply with exactly: pong", {
        id: inputID,
      });
      log("prompt admitted");
      await waitFor("busy on pong turn", () => state.status === "busy");
      // The drain is live while busy — cross-checks the one-shot
      // `/api/session/active` seeding the sidebar uses.
      expect(await client.activeSessionIDs()).toContain(session.id);
      await waitFor("idle after pong", () => state.status === "idle");
      // Let the terminal durable events flush through the stream.
      await new Promise((r) => setTimeout(r, 2000));

      const users = state.rows.filter((r) => r.kind === "user");
      expect(
        users.some((r) => r.kind === "user" && r.text.includes("pong")),
      ).toBe(true);
      // Optimistic-id reconcile: the admitted prompt echoes our id.
      expect(users.some((r) => r.id === inputID)).toBe(true);
      const texts = state.rows.filter((r) => r.kind === "text");
      expect(texts.length).toBeGreaterThan(0);
      const fullText = texts
        .map((r) => (r.kind === "text" ? r.text : ""))
        .join("");
      log(
        `rows: ${JSON.stringify(state.rows.map((r) => (r.kind === "text" || r.kind === "reasoning" ? { kind: r.kind, id: r.id, streaming: r.streaming, text: r.text.slice(0, 20) } : { kind: r.kind, id: r.id })))}`,
      );
      // At least one streaming row converged on the final text.
      expect(fullText.toLowerCase()).toContain("pong");
      expect(texts.some((r) => r.kind === "text" && !r.streaming)).toBe(true);
      expect(transitions).toEqual(["busy", "idle"]);
      expect(state.usage?.inputTokens).toBeGreaterThan(0);
      console.log(`E2E stream types: ${streamTypes.join(" → ")}`);
      console.log(`E2E bus types: ${busTypes.join(" → ")}`);
      console.log(`E2E transitions: ${transitions.join(" → ")}`);

      // Turn 2: long prompt, then interrupt mid-stream → failed-step row.
      // Wait for genuine assistant activity before interrupting: the
      // admission user row is not enough (interrupting a queued turn
      // is a server-side no-op that can leave it never running).
      busTypes.length = 0;
      streamTypes.length = 0;
      transitions.length = 0;
      const assistantRowsBefore = state.rows.filter(
        (r) => r.kind !== "user",
      ).length;
      await client.prompt(
        session.id,
        "write a very long story, at least 2000 words, about a lighthouse keeper",
      );
      await waitFor("busy on long prompt", () => state.status === "busy");
      await waitFor(
        "assistant activity on long prompt",
        () =>
          state.rows.filter((r) => r.kind !== "user").length >
          assistantRowsBefore,
      );
      await client.interrupt(session.id);
      log("interrupted");
      await waitFor(
        "failed step row",
        () =>
          state.rows.some((r) => r.kind === "step-failed") &&
          state.status === "idle",
      );
      const failed = state.rows.filter((r) => r.kind === "step-failed");
      expect(failed.length).toBeGreaterThan(0);
      console.log(`E2E interrupt stream types: ${streamTypes.join(" → ")}`);
      console.log(`E2E interrupt bus types: ${busTypes.join(" → ")}`);
      console.log(`E2E interrupt transitions: ${transitions.join(" → ")}`);

      // Model switch + delete through the proxy (no turn needed): the
      // picker routes (`/api/model`, `/api/provider`, v2 model switch)
      // and the v1-compat delete shim.
      const [providers, models] = await Promise.all([
        client.listProviders(),
        client.listModels(),
      ]);
      expect(providers.length).toBeGreaterThan(0);
      expect(models.length).toBeGreaterThan(0);
      const other =
        models.find(
          (m) => m.providerID !== model.providerID || m.id !== model.id,
        ) ?? models[0];
      if (other === undefined) throw new Error("no models listed");
      await client.switchModel(session.id, {
        providerID: other.providerID,
        id: other.id,
      });
      const switched = await client.getSession(session.id);
      expect(switched.model).toMatchObject({
        providerID: other.providerID,
        id: other.id,
      });
      console.log(`E2E switched model to ${other.providerID}/${other.id}`);
      await client.deleteSession(session.id);
      await expect(client.getSession(session.id)).rejects.toThrow();
      const after = await client.listSessions({ limit: 100 });
      expect(after.sessions.some((s) => s.id === session.id)).toBe(false);
      log("deleted");

      abort.abort();
      await Promise.race([
        pump.catch(() => {}),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
    } finally {
      abort.abort();
      console.log(`E2E server log tail:\n${serverLog.slice(-30).join("\n")}`);
      await new Promise<void>((r) => {
        if (proxy !== null) proxy.close(() => r());
        else r();
      });
      await host.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
