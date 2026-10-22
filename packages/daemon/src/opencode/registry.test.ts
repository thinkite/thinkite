import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createOpencodeDiscovery,
  discoverOpencode,
  isSupportedOpencodeVersion,
  parseOpencodeVersion,
  readRegistration,
  registryPath,
} from "./registry.ts";

async function registration(overrides: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "thinkite-registry-"));
  const path = join(dir, "service.json");
  await writeFile(
    path,
    JSON.stringify({
      id: "svc",
      version: "2.0.2",
      url: "http://127.0.0.1:49374",
      pid: 42,
      password: "secret",
      ...overrides,
    }),
  );
  return path;
}

function fakeFetch(info: unknown, status = 200) {
  const calls: Array<{ url: string; auth: string | undefined }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url: String(input),
      auth: headers.get("authorization") ?? undefined,
    });
    return new Response(JSON.stringify(info), { status });
  }) as typeof fetch;
  return { impl, calls };
}

describe("opencode registry discovery", () => {
  it("resolves the registry path under XDG_STATE_HOME", () => {
    expect(registryPath({ XDG_STATE_HOME: "/x/state" })).toBe(
      "/x/state/opencode/service.json",
    );
  });

  it("reads a registration and rejects malformed files", async () => {
    expect(await readRegistration(await registration())).toMatchObject({
      url: "http://127.0.0.1:49374",
      pid: 42,
    });
    expect(
      await readRegistration(await registration({ password: undefined })),
    ).toBeNull();
    expect(await readRegistration("/nonexistent/service.json")).toBeNull();
  });

  it("accepts a service whose pid matches, with Basic auth on the probe", async () => {
    const path = await registration();
    const { impl, calls } = fakeFetch({ version: "2.1.2", pid: 42 });
    const found = await discoverOpencode(path, impl);
    expect(found).toMatchObject({
      baseUrl: "http://127.0.0.1:49374",
      username: "opencode",
      password: "secret",
      version: "2.1.2",
      pid: 42,
    });
    expect(calls[0]?.url).toBe("http://127.0.0.1:49374/api/info");
    expect(calls[0]?.auth).toBe(
      `Basic ${Buffer.from("opencode:secret").toString("base64")}`,
    );
  });

  it("treats a pid mismatch or a failed probe as stale", async () => {
    const path = await registration();
    expect(
      await discoverOpencode(
        path,
        fakeFetch({ version: "2.1.2", pid: 43 }).impl,
      ),
    ).toBeNull();
    expect(await discoverOpencode(path, fakeFetch({}, 503).impl)).toBeNull();
  });

  it("caches a hit for the ttl and reports replacements", async () => {
    const path = await registration();
    const { impl, calls } = fakeFetch({ version: "2.1.2", pid: 42 });
    const changes: Array<string | null> = [];
    const discovery = createOpencodeDiscovery({
      path,
      fetchImpl: impl,
      ttlMs: 60_000,
      onChange: (n) => changes.push(n?.version ?? null),
    });
    await discovery.resolve();
    await discovery.resolve();
    expect(calls).toHaveLength(1);
    expect(changes).toEqual(["2.1.2"]);
    discovery.invalidate();
    await discovery.resolve();
    expect(calls).toHaveLength(2);
    expect(changes).toEqual(["2.1.2"]);
  });
});

describe("opencode version gate", () => {
  it("parses stable, beta and dev versions", () => {
    expect(parseOpencodeVersion("2.0.2")).toEqual({
      channel: "stable",
      major: 2,
      minor: 0,
      patch: 2,
    });
    expect(parseOpencodeVersion("v1.18.30")).toMatchObject({
      channel: "stable",
      major: 1,
    });
    expect(parseOpencodeVersion("0.0.0-beta-19425")).toEqual({
      channel: "beta",
      build: 19425,
    });
    expect(parseOpencodeVersion("0.0.0-dev")).toEqual({ channel: "dev" });
    expect(parseOpencodeVersion("")).toBeNull();
    expect(parseOpencodeVersion("latest")).toBeNull();
  });

  it("accepts stable ≥ 2.1.0 plus any v2 beta/dev build, rejects 1.x and 2.0", () => {
    expect(isSupportedOpencodeVersion("2.0.2")).toBe(false);
    expect(isSupportedOpencodeVersion("2.1.0")).toBe(true);
    expect(isSupportedOpencodeVersion("2.1.2")).toBe(true);
    expect(isSupportedOpencodeVersion("3.0.0")).toBe(true);
    expect(isSupportedOpencodeVersion("0.0.0-beta-19425")).toBe(true);
    expect(isSupportedOpencodeVersion("0.0.0-dev")).toBe(true);
    expect(isSupportedOpencodeVersion("1.18.30")).toBe(false);
    expect(isSupportedOpencodeVersion("1.99.0")).toBe(false);
    expect(isSupportedOpencodeVersion("")).toBe(false);
  });
});
