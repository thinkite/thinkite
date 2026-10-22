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

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OcClient } from "./client.ts";
import {
  type IsolatedService,
  startIsolatedService,
} from "./isolated-service.e2e.ts";

const runIf =
  process.env.THINKITE_E2E_PROVIDERS === "1" ? describe : describe.skip;

runIf("provider connections (isolated service)", () => {
  let service: IsolatedService;
  let client: OcClient;

  beforeAll(async () => {
    service = await startIsolatedService("oc-providers-e2e-");
    client = service.client;
  }, 40_000);

  afterAll(() => service?.stop());

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
