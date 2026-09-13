/**
 * End-to-end: HTTP + SSE through the daemon's `thinkite/http/1` tunnel
 * against the user's registered opencode 2 service (the same discovery
 * `Daemon.opencode()` uses — nothing is spawned), then a delete so the
 * scratch session doesn't litter the user's opencode database.
 *
 * Gated by `THINKITE_E2E_IROH_HTTP=1` (spends one cheap model turn on the
 * registered service):
 *
 *   THINKITE_E2E_IROH_HTTP=1 bunx vitest run packages/daemon/src/iroh-http-tunnel.e2e.test.ts
 *
 * Speaks raw HTTP/1.1 over iroh bi-streams on purpose (the phone's fetch
 * does the same) so the test covers the tunnel, not `@thinkite/oc-client`
 * — the desktop `oc-proxy.e2e.test.ts` covers the client. Run under Node:
 * bun's node:http ignores `createConnection`.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Connection, Endpoint, EndpointAddr } from "@number0/iroh";
import { IROH_HTTP_ALPN } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import { fingerprintFromPubkeyB64, loadOrCreateIdentity } from "./identity.ts";
import { irohDuplex } from "./iroh-duplex.ts";
import { IrohPeerServer } from "./iroh-peer-server.ts";
import { KnownClients } from "./known-clients.ts";
import { discoverOpencode } from "./opencode/registry.ts";

const runIf =
  process.env.THINKITE_E2E_IROH_HTTP === "1" ? describe : describe.skip;

/** One `/api/event` payload: `{ type, data: { sessionID?, … } }`. */
interface Ev {
  type?: string;
  data?: Record<string, unknown>;
}

const parse = (d: string): Ev => {
  try {
    return JSON.parse(d) as Ev;
  } catch {
    return { data: { text: d } };
  }
};

interface IrohHttpClient {
  request(
    method: string,
    path: string,
    opts?: { body?: unknown; headers?: Record<string, string> },
  ): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    text: string;
    json: () => unknown;
  }>;
  /** SSE stream; resolves once headers arrive. `abort()` resets the QUIC stream. */
  sse(
    path: string,
    onEvent: (e: { id?: string; event?: string; data: string }) => void,
  ): Promise<{ status: number; abort: () => void; done: Promise<void> }>;
  close(): Promise<void>;
}

/** The paired client endpoint dials the daemon and speaks HTTP over bi-streams. */
async function connectIrohHttp(
  ep: Endpoint,
  addr: EndpointAddr,
  log: (m: string) => void,
): Promise<IrohHttpClient> {
  const conn: Connection = await ep.connect(
    addr,
    Array.from(Buffer.from(IROH_HTTP_ALPN)),
  );
  log(`client connected, rtt=${conn.rtt()}`);

  const open = async () =>
    irohDuplex(await conn.openBi(), (m) => log(`  [client stream] ${m}`));

  const raw = async (
    method: string,
    path: string,
    headers: Record<string, string>,
    body?: Buffer,
  ) => {
    const sock = await open();
    return new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          createConnection: () => sock as never,
          method,
          path,
          headers: { host: "daemon.iroh", ...headers },
        },
        resolve,
      );
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  };

  return {
    async request(method, path, opts = {}) {
      const body =
        opts.body === undefined
          ? undefined
          : Buffer.from(JSON.stringify(opts.body));
      const headers: Record<string, string> = { ...(opts.headers ?? {}) };
      if (body) {
        headers["content-type"] = "application/json";
        headers["content-length"] = String(body.length);
      }
      const res = await raw(method, path, headers, body);
      const chunks: Buffer[] = [];
      for await (const c of res) chunks.push(c as Buffer);
      const text = Buffer.concat(chunks).toString();
      return {
        status: res.statusCode ?? 0,
        headers: res.headers,
        text,
        json: () => JSON.parse(text),
      };
    },
    async sse(path, onEvent) {
      const res = await raw("GET", path, { accept: "text/event-stream" });
      let buf = "";
      const done = new Promise<void>((resolve) => {
        res.on("data", (c: Buffer) => {
          buf += c.toString();
          let idx = buf.indexOf("\n\n");
          while (idx >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const e: { id?: string; event?: string; data: string } = {
              data: "",
            };
            for (const line of block.split("\n")) {
              if (line.startsWith("data:")) {
                e.data += (e.data ? "\n" : "") + line.slice(5).trimStart();
              } else if (line.startsWith("id:")) e.id = line.slice(3).trim();
              else if (line.startsWith("event:"))
                e.event = line.slice(6).trim();
            }
            if (e.data) onEvent(e);
            idx = buf.indexOf("\n\n");
          }
        });
        res.on("end", () => resolve());
        res.on("error", () => resolve());
        res.on("close", () => resolve());
      });
      return {
        status: res.statusCode ?? 0,
        abort: () => res.destroy(),
        done,
      };
    },
    async close() {
      conn.close(0n, []);
    },
  };
}

async function makeClientEndpoint(): Promise<{
  ep: Endpoint;
  pubkeyB64: string;
}> {
  const b = Endpoint.builder();
  b.applyMinimal();
  b.secretKey(Array.from(randomBytes(32)));
  const ep = await b.bind();
  const pubkeyB64 = Buffer.from(Uint8Array.from(ep.id().toBytes())).toString(
    "base64url",
  );
  return { ep, pubkeyB64 };
}

/** Server's dialable address, with loopback fallbacks for wildcard binds. */
function dialAddr(server: IrohPeerServer): EndpointAddr {
  const addr = server.endpointAddr();
  const direct = addr.directAddresses();
  const loopback = direct
    .map((a) => a.slice(a.lastIndexOf(":")))
    .map((port) => `127.0.0.1${port}`);
  return new EndpointAddr(addr.id(), null, [...direct, ...loopback]);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new Error(`${label} not received in ${ms}ms`)),
        ms,
      );
    }),
  ]);
}

runIf("iroh http tunnel (registered opencode service)", () => {
  it("health → create → prompt+SSE → abort → fresh SSE → messages → delete", {
    timeout: 300_000,
  }, async () => {
    const upstream = await discoverOpencode();
    if (upstream === null)
      throw new Error("no healthy opencode service registered");
    const home = mkdtempSync(join(tmpdir(), "iroh-http-e2e-"));
    const dir = mkdtempSync(join(tmpdir(), "oc-iroh-http-e2e-"));
    const serverLog: string[] = [];
    const t0 = Date.now();
    const log = (m: string) =>
      console.log(
        `[e2e iroh-http +${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`,
      );
    let sid: string | null = null;
    let client: IrohHttpClient | null = null;
    let server: IrohPeerServer | null = null;
    let ep: Endpoint | null = null;
    const forSession = (e: Ev) =>
      sid !== null && e.data?.sessionID === sid && typeof e.type === "string";
    try {
      const identity = loadOrCreateIdentity(home);
      const knownClients = KnownClients.load(home);
      const { ep: clientEp, pubkeyB64 } = await makeClientEndpoint();
      ep = clientEp;
      knownClients.add({
        fingerprint: fingerprintFromPubkeyB64(pubkeyB64),
        publicKeyB64: pubkeyB64,
        pairedAt: Date.now(),
      });
      log(`known client ${pubkeyB64.slice(0, 12)}…`);

      // A real IrohPeerServer with the registered service as the tunnel
      // target — same wiring as index.ts, minus the desktop surfaces.
      server = new IrohPeerServer({
        identity,
        knownClients,
        preset: "minimal",
        opencode: async () => upstream,
        log: (event, data) =>
          serverLog.push(`${event}${data ? ` ${JSON.stringify(data)}` : ""}`),
      });
      await server.start();
      const tunnel = await connectIrohHttp(clientEp, dialAddr(server), log);
      client = tunnel;

      // 1. health through the tunnel: credentials are injected daemon-side,
      //    the client sends none, and the answer is the registered pid.
      const health = await tunnel.request("GET", "/api/health");
      expect(health.status, health.text).toBe(200);
      expect((health.json() as { pid?: number }).pid).toBe(upstream.pid);
      log(`health 200 (opencode ${upstream.version})`);

      // 2. v2 surface present.
      const list = await client.request("GET", "/api/session?limit=1");
      expect(list.status, list.text.slice(0, 200)).toBe(200);

      // 3. create the scratch session (service default model).
      const created = await client.request("POST", "/api/session", {
        body: { title: "iroh http e2e", location: { directory: dir } },
      });
      expect(created.status, created.text.slice(0, 200)).toBe(200);
      sid = (created.json() as { data: { id: string } }).data.id;
      log(`session ${sid}`);

      // 4. global SSE (headers flush with `server.connected`) + prompt;
      //    abort the stream after 3 events for this session — the phone
      //    backgrounding mid-turn.
      const seen: string[] = [];
      const holder: { abort?: () => void } = {};
      let aborted = false;
      const s1 = await withTimeout(
        client.sse("/api/event", (e) => {
          const ev = parse(e.data);
          if (!forSession(ev)) return;
          seen.push(ev.type as string);
          log(`  sse#1 ${ev.type}`);
          if (seen.length === 3 && !aborted) {
            aborted = true;
            holder.abort?.();
            log("  sse#1 ABORTED on purpose");
          }
        }),
        30_000,
        "sse#1 headers",
      );
      holder.abort = s1.abort;
      expect(s1.status).toBe(200);
      const p = await client.request("POST", `/api/session/${sid}/prompt`, {
        body: { text: "Reply with exactly: pong" },
      });
      expect(p.status, p.text.slice(0, 200)).toBe(200);
      await withTimeout(s1.done, 120_000, "sse#1 abort");
      expect(seen.length, `saw ${seen.join(",")}`).toBeGreaterThanOrEqual(3);

      // 5. a fresh stream on a new bi-stream sees the rest of the turn.
      //    The turn may already be over (pong is quick), so `session.active`
      //    polling is the second exit: the service drops the id from the
      //    map once execution settles.
      const resumed: string[] = [];
      let settled: (() => void) | null = null;
      const finished = new Promise<void>((resolve) => {
        settled = resolve;
      });
      const s2 = await withTimeout(
        client.sse("/api/event", (e) => {
          const ev = parse(e.data);
          if (!forSession(ev)) return;
          resumed.push(ev.type as string);
          log(`  sse#2 ${ev.type}`);
          if (ev.type === "session.execution.succeeded") settled?.();
        }),
        30_000,
        "sse#2 headers",
      );
      const started = [...seen, ...resumed].includes(
        "session.execution.started",
      );
      const idle = (async () => {
        for (;;) {
          await new Promise((r) => setTimeout(r, 500));
          const active = await tunnel.request("GET", "/api/session/active");
          const map = (active.json() as { data?: Record<string, unknown> })
            .data;
          if (started && map !== undefined && !((sid as string) in map)) return;
        }
      })();
      await withTimeout(Promise.race([finished, idle]), 120_000, "turn end");
      s2.abort();
      await s2.done;
      log(`turn settled (sse#2 saw ${resumed.length} events)`);

      // 6. the projection agrees: one assistant message, text "pong".
      const page = await client.request(
        "GET",
        `/api/session/${sid}/message?limit=10&order=desc`,
      );
      expect(page.status, page.text.slice(0, 200)).toBe(200);
      const messages = (
        page.json() as {
          data: Array<{
            type: string;
            content?: Array<{ type: string; text?: string }>;
          }>;
        }
      ).data;
      const assistant = messages.find((m) => m.type === "assistant");
      const text =
        assistant?.content?.find((c) => c.type === "text")?.text ?? "";
      expect(text.trim(), JSON.stringify(assistant)).toMatch(/^pong[.!]?$/i);
      log(`final text ${JSON.stringify(text)}`);

      // 7. delete so the scratch session leaves no trace (204; a second
      //    delete is 404 — the service is not idempotent, the client is).
      const del = await client.request("DELETE", `/api/session/${sid}`);
      expect(del.status, del.text.slice(0, 200)).toBe(204);
      log(`deleted ${sid}`);
      sid = null;
    } finally {
      if (sid !== null && client !== null) {
        await client.request("DELETE", `/api/session/${sid}`).catch(() => {});
      }
      console.log(
        `E2E iroh-http server log tail:\n${serverLog.slice(-20).join("\n")}`,
      );
      await client?.close().catch(() => {});
      await server?.stop().catch(() => {});
      await ep?.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
