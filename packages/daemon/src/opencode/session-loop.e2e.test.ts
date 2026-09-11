/**
 * End-to-end: a real turn through the daemon's opencode session loop.
 *
 * Gated by `THINKITE_E2E_OPENCODE=1` (spawns a real `opencode serve` and
 * spends one cheap model turn). Uses the ambient opencode integration
 * state for credentials, like the daemon host does.
 *
 *   THINKITE_E2E_OPENCODE=1 bunx vitest run packages/daemon/src/opencode/session-loop.e2e.test.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventDelta } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import { foldEventDelta } from "../messages/fold.ts";
import { SessionRuntimeManager } from "../runtime/session-runtime-manager.ts";
import { OpencodeHost } from "./host.ts";
import {
  ensureOpencodeLoop,
  pushOpencodePrompt,
  shutdownOpencodeLoops,
} from "./session-loop.ts";

const runIf =
  process.env.THINKITE_E2E_OPENCODE === "1" ? describe : describe.skip;

runIf("opencode session loop (live server)", () => {
  it("streams user append, assistant append, patch_text, and turn end", {
    timeout: 180_000,
  }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-e2e-"));
    const host = new OpencodeHost(() => {});
    const manager = new SessionRuntimeManager<EventDelta>({
      foldDelta: foldEventDelta,
      log: () => {},
    });
    const sessionId = crypto.randomUUID();
    const runtime = manager.getOrCreate(sessionId);
    const seen: EventDelta[] = [];
    runtime.subscribe(() => {});
    const unsubscribe = runtime.subscribe((event) => {
      seen.push(event.payload);
    });
    let opencodeSessionId: string | null = null;
    try {
      const loop = await ensureOpencodeLoop(manager, host, runtime, {
        text: "reply with exactly: pong",
        cwd: dir,
      });
      opencodeSessionId = loop.opencodeSessionId;
      await pushOpencodePrompt(manager, host, runtime, loop, {
        text: "reply with exactly: pong",
        cwd: dir,
      });
      // Wait for the turn to settle (the waiter emits the terminal delta).
      const deadline = Date.now() + 150_000;
      for (;;) {
        const last = seen[seen.length - 1];
        if (
          last?.kind === "turn_completed" ||
          last?.kind === "turn_failed" ||
          last?.kind === "turn_canceled"
        ) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(
            `turn did not settle; last delta: ${JSON.stringify(last)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      const kinds = seen.map((d) => d.kind);
      expect(kinds[0]).toBe("turn_started");
      // user_message append may arrive just after turn_started.
      const appends = seen.filter((d) => d.kind === "append");
      expect(
        appends.some(
          (d) =>
            d.kind === "append" &&
            d.item.type === "user_message" &&
            d.item.text.includes("pong"),
        ),
      ).toBe(true);
      expect(
        appends.some(
          (d) => d.kind === "append" && d.item.type === "assistant_message",
        ),
      ).toBe(true);
      expect(kinds).toContain("patch_text");
      const last = seen[seen.length - 1];
      expect(last?.kind).toBe("turn_completed");
      // Final text contains pong (fold the assistant patches).
      const texts = seen.flatMap((d) =>
        d.kind === "append" && d.item.type === "assistant_message"
          ? [d.item.text]
          : d.kind === "patch_text"
            ? [d.deltaText]
            : [],
      );
      expect(texts.join("")).toContain("pong");
      //nolint: observed delta sequence is pasted into the stage-1 report.
      console.log(`E2E delta kinds: ${kinds.join(" → ")}`);
      unsubscribe();
    } finally {
      // Best-effort cleanup so a passing or failing run doesn't litter the
      // user's opencode session database (v1 delete: no v2 route exists).
      const client = host.client;
      if (client !== null && opencodeSessionId !== null) {
        await client.deleteSession(opencodeSessionId).catch(() => {});
      }
      await shutdownOpencodeLoops();
      await host.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
