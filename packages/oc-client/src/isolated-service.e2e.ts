/**
 * A throwaway opencode 2 service for end-to-end tests: `opencode serve` with
 * its state, data, config and cache in a temp dir, so nothing it does
 * touches the user's own service, credentials or sessions. Needs `opencode`
 * (≥ 2.1) on PATH.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOcClient, type OcClient } from "./client.ts";

const PASSWORD = "thinkite-e2e";

export interface IsolatedService {
  readonly client: OcClient;
  /** The temp dir the service lives in; tests may use it as a project. */
  readonly dir: string;
  stop(): void;
}

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

export async function startIsolatedService(
  prefix: string,
): Promise<IsolatedService> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const port = await freePort();
  const service: ChildProcess = spawn(
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
  return {
    client: createOcClient({ baseUrl, password: PASSWORD }),
    dir,
    stop() {
      service.kill();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
