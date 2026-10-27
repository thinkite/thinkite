/**
 * Discover the user's opencode 2 background service from the opencode
 * registry instead of spawning our own server.
 *
 * opencode 2 (`opencode serve --service`, started by the desktop app or
 * the TUI) registers itself in `<state>/opencode/service.json` as
 * `{ id, version, url, pid, password }` and re-reads that file every 5 s,
 * shutting down if another service replaced it. Clients that carry no
 * version (us) simply attach to whatever is registered; on an upgrade the
 * url and password stay stable, only pid/version change. We never write
 * the file and never start a contender against it.
 *
 * Validation mirrors `@opencode/client`'s `discover`: the registered
 * `pid` must match `/api/info`, otherwise the file is stale.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface OpencodeRegistration {
  id: string;
  version: string;
  url: string;
  pid: number;
  password: string;
}

/** Address + Basic credentials of the opencode server (proxy use only). */
export interface OpencodeConnection {
  baseUrl: string;
  username: string;
  password: string;
  /** Reported by `/api/info` (e.g. `2.1.2`, `0.0.0-beta-19425`). */
  version: string;
}

export interface DiscoveredOpencode extends OpencodeConnection {
  username: "opencode";
  pid: number;
}

/**
 * Version gate. Thinkite speaks the opencode API from 2.1 on (2.0 had
 * `/api/health` where 2.1 has `/api/info`); there is no upper bound, since
 * the client reads responses as plain JSON and newer services only add
 * fields and events. Accepted: stable releases from 2.1.0, plus the
 * `0.0.0-beta-N` builds the
 * Beta desktop app ships (fast-forward snapshots of the `v2` trunk, so a
 * beta is never older than 2.0.0 in API terms) and `0.0.0-dev` source
 * builds. A 1.x service (`opencode-ai` npm, GitHub Releases, brew) never
 * registers itself, but the check keeps a mis-registered one from
 * answering v2 routes with 404s that would look like data.
 */
export const OPENCODE_MIN_STABLE = "2.1.0";

export type OpencodeVersion =
  | { channel: "stable"; major: number; minor: number; patch: number }
  | { channel: "beta"; build: number }
  | { channel: "dev" };

export function parseOpencodeVersion(version: string): OpencodeVersion | null {
  const stable = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (stable !== null) {
    return {
      channel: "stable",
      major: Number(stable[1]),
      minor: Number(stable[2]),
      patch: Number(stable[3]),
    };
  }
  const beta = /^0\.0\.0-beta-(\d+)$/.exec(version);
  if (beta !== null) return { channel: "beta", build: Number(beta[1]) };
  if (/^0\.0\.0-dev/.test(version)) return { channel: "dev" };
  return null;
}

export function isSupportedOpencodeVersion(version: string): boolean {
  const parsed = parseOpencodeVersion(version);
  if (parsed === null) return false;
  if (parsed.channel !== "stable") return true;
  const min = parseOpencodeVersion(OPENCODE_MIN_STABLE);
  if (min?.channel !== "stable") return false;
  return (
    parsed.major > min.major ||
    (parsed.major === min.major &&
      (parsed.minor > min.minor ||
        (parsed.minor === min.minor && parsed.patch >= min.patch)))
  );
}

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(state, "opencode", "service.json");
}

export async function readRegistration(
  path = registryPath(),
): Promise<OpencodeRegistration | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Partial<OpencodeRegistration>;
    if (
      typeof parsed.url !== "string" ||
      typeof parsed.password !== "string" ||
      typeof parsed.pid !== "number"
    )
      return null;
    return {
      id: typeof parsed.id === "string" ? parsed.id : "",
      version: typeof parsed.version === "string" ? parsed.version : "",
      url: parsed.url.replace(/\/+$/, ""),
      pid: parsed.pid,
      password: parsed.password,
    };
  } catch {
    return null;
  }
}

/** Probe the registered service; null when absent, unhealthy or stale. */
export async function discoverOpencode(
  path = registryPath(),
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveredOpencode | null> {
  const registration = await readRegistration(path);
  if (registration === null) return null;
  try {
    const res = await fetchImpl(`${registration.url}/api/info`, {
      headers: {
        authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}`,
      },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const info = (await res.json()) as { version?: string; pid?: number };
    if (info.pid !== registration.pid) return null;
    return {
      baseUrl: registration.url,
      username: "opencode",
      password: registration.password,
      version: info.version ?? registration.version,
      pid: registration.pid,
    };
  } catch {
    return null;
  }
}

/**
 * Cached discovery for hot paths (the desktop proxy asks per request):
 * a healthy answer is reused for `ttlMs`; a miss is retried on the next
 * call. `onChange` fires when the discovered pid/version differs from the
 * last answer (service replaced by an upgrade).
 */
export function createOpencodeDiscovery(
  options: {
    ttlMs?: number;
    path?: string;
    fetchImpl?: typeof fetch;
    onChange?: (next: DiscoveredOpencode | null) => void;
  } = {},
) {
  const ttlMs = options.ttlMs ?? 5000;
  let cached: DiscoveredOpencode | null = null;
  let cachedAt = 0;
  let inflight: Promise<DiscoveredOpencode | null> | null = null;
  return {
    async resolve(): Promise<DiscoveredOpencode | null> {
      if (cached !== null && Date.now() - cachedAt < ttlMs) return cached;
      if (inflight !== null) return inflight;
      inflight = (async () => {
        const next = await discoverOpencode(options.path, options.fetchImpl);
        if (
          next?.pid !== cached?.pid ||
          next?.version !== cached?.version ||
          next?.baseUrl !== cached?.baseUrl
        ) {
          options.onChange?.(next);
        }
        cached = next;
        cachedAt = Date.now();
        inflight = null;
        return next;
      })();
      return inflight;
    },
    /** Force a re-probe on the next call (keeps the last answer for
     *  change detection). */
    invalidate(): void {
      cachedAt = 0;
    },
  };
}
