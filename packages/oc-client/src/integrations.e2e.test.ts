/**
 * End-to-end: the provider connection calls against a real opencode 2
 * service of their own — `opencode serve` with its state, data, config and
 * cache in a temp dir, so its credentials never touch the user's. No model
 * turns, and the one sign-in it starts (Poe's, a local PKCE listener on a
 * random port) is cancelled before it could open anything.
 *
 * Gated by `THINKITE_E2E_PROVIDERS=1`; needs `opencode` (≥ 2.1) on PATH:
 *
 *   THINKITE_E2E_PROVIDERS=1 bunx vitest run packages/oc-client/src/integrations.e2e.test.ts
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOcClient, type OcClient } from "./client.ts";

const runIf =
  process.env.THINKITE_E2E_PROVIDERS === "1" ? describe : describe.skip;

const PASSWORD = "thinkite-e2e";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForService(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  const auth = `Basic ${btoa(`opencode:${PASSWORD}`)}`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/info`, {
        headers: { authorization: auth },
      });
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("isolated opencode service did not start");
}

runIf("provider connections (isolated service)", () => {
  let dir = "";
  let service: ChildProcess | null = null;
  let client: OcClient;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "oc-providers-e2e-"));
    const port = await freePort();
    service = spawn(
      "opencode",
      ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
      {
        cwd: dir,
        stdio: "ignore",
        env: {
          ...process.env,
          XDG_STATE_HOME: join(dir, "state"),
          XDG_DATA_HOME: join(dir, "data"),
          XDG_CONFIG_HOME: join(dir, "config"),
          XDG_CACHE_HOME: join(dir, "cache"),
          OPENCODE_SERVER_PASSWORD: PASSWORD,
        },
      },
    );
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForService(baseUrl);
    client = createOcClient({ baseUrl, password: PASSWORD });
  }, 40_000);

  afterAll(() => {
    service?.kill();
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  const deepseek = async () =>
    (await client.listIntegrations()).find((i) => i.id === "deepseek");
  const credentials = async () =>
    (await deepseek())?.connections.flatMap((c) =>
      c.type === "credential" ? [c] : [],
    ) ?? [];

  it("lists providers with how each connects", async () => {
    const all = await client.listIntegrations();
    expect(all.length).toBeGreaterThan(50);
    const openai = all.find((i) => i.id === "openai");
    expect(openai?.methods.map((m) => m.type)).toEqual(
      expect.arrayContaining(["key", "oauth"]),
    );
    expect((await deepseek())?.connections).toEqual([]);
  });

  it("connects a key, renames, switches and removes accounts", async () => {
    await client.connectKey("deepseek", "sk-e2e-first");
    const [first] = await credentials();
    expect(first).toMatchObject({ method: "key", label: "DeepSeek" });
    const providers = await client.listProviders();
    expect(providers.map((p) => p.id)).toContain("deepseek");

    await client.renameCredential(first?.id as string, "Work");
    await client.connectKey("deepseek", "sk-e2e-second");
    const two = await credentials();
    expect(two).toHaveLength(2);
    expect(two.map((c) => c.label)).toContain("Work");

    // The newest key is active; switch back to the first.
    await client.activateCredential(first?.id as string);
    const active = (await client.raw.credential.list()).find((c) => c.active);
    expect(active?.id).toBe(first?.id);

    for (const c of two) await client.removeCredential(c.id);
    expect(await credentials()).toEqual([]);
  });

  it("starts a sign-in and cancels it", async () => {
    const attempt = await client.startOAuth("poe", "browser");
    expect(attempt.url).toMatch(/^https:\/\/poe\.com\/oauth\/authorize/);
    expect(["auto", "code"]).toContain(attempt.mode);
    expect((await client.oauthStatus("poe", attempt.attemptID)).status).toBe(
      "pending",
    );
    await client.cancelOAuth("poe", attempt.attemptID);
    await expect(
      client.oauthStatus("poe", attempt.attemptID),
    ).rejects.toBeDefined();
  });
});
