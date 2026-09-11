/**
 * End-to-end: HTTP + SSE through the daemon's `thinkite/http/1` tunnel
 * against a real `opencode serve`, then a v1-route delete so the scratch
 * session doesn't litter the user's opencode database.
 *
 * Gated by `THINKITE_E2E_IROH_HTTP=1` (spawns a real server and spends one
 * cheap model turn). Uses the ambient opencode integration state for
 * credentials, like the daemon host does.
 *
 *   THINKITE_E2E_IROH_HTTP=1 bunx vitest run packages/daemon/src/iroh-http-tunnel.e2e.test.ts
 *
 * Port of `spikes/oc-proxy/client.ts` + `run.ts` onto the daemon's real
 * `IrohPeerServer`. Run under Node: bun's node:http ignores
 * `createConnection`.
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
import { OpencodeHost, resolveOpencodeModel } from "./opencode/host.ts";

const runIf =
  process.env.THINKITE_E2E_IROH_HTTP === "1" ? describe : describe.skip;

interface Ev {
  id?: string;
  type?: string;
  durable?: { aggregateID: string; seq: number };
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

/** Resolves once no event has arrived for `idleMs` — the turn settled. */
function settleWaiter(idleMs: number): {
  arm: () => void;
  settled: Promise<void>;
} {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void;
  const settled = new Promise<void>((r) => {
    resolve = r;
  });
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(resolve, idleMs);
  };
  arm();
  return { arm, settled };
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

runIf("iroh http tunnel (live opencode)", () => {
  it("health → create → prompt+SSE → abort → resume → delete", {
    timeout: 300_000,
  }, async () => {
    const home = mkdtempSync(join(tmpdir(), "iroh-http-e2e-"));
    const dir = mkdtempSync(join(tmpdir(), "oc-iroh-http-e2e-"));
    const host = new OpencodeHost(() => {});
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

      // A real IrohPeerServer with the daemon's opencode host as the tunnel
      // target — same wiring as index.ts, minus the desktop surfaces.
      server = new IrohPeerServer({
        identity,
        knownClients,
        preset: "minimal",
        opencode: () => host.ensureConnection(),
        log: (event, data) =>
          serverLog.push(`${event}${data ? ` ${JSON.stringify(data)}` : ""}`),
      });
      await server.start();
      client = await connectIrohHttp(clientEp, dialAddr(server), log);

      // 1. health through the tunnel, no credentials on the client side.
      const health = await client.request("GET", "/global/health");
      expect(health.status, health.text).toBe(200);
      log("health 200");

      // 2. v2 surface present.
      const list = await client.request(
        "GET",
        `/api/session?directory=${encodeURIComponent(dir)}`,
      );
      expect(list.status, list.text.slice(0, 200)).toBe(200);

      // 3. create the scratch session.
      const model = resolveOpencodeModel();
      const created = await client.request("POST", "/api/session", {
        body: { location: { directory: dir }, model },
      });
      expect([200, 201], created.text.slice(0, 200)).toContain(created.status);
      sid = (created.json() as { data: { id: string } }).data.id;
      log(`session ${sid}`);

      // 4. SSE from seq 0 (headers flush with the first event) + prompt
      //    concurrently; abort after 3 events.
      const seen: Ev[] = [];
      let abortAt = -1;
      const holder: { abort?: () => void } = {};
      const s1p = client.sse(`/api/session/${sid}/event?after=0`, (e) => {
        const ev = parse(e.data);
        seen.push(ev);
        log(`  sse#1 seq=${ev.durable?.seq} ${ev.type}`);
        if (seen.length === 3 && abortAt < 0) {
          abortAt = ev.durable?.seq ?? -1;
          holder.abort?.();
          log("  sse#1 ABORTED on purpose");
        }
      });
      const p = await client.request("POST", `/api/session/${sid}/prompt`, {
        body: { prompt: { text: "reply with exactly: pong" } },
      });
      expect(p.status, p.text.slice(0, 200)).toBe(200);
      const s1 = await withTimeout(s1p, 30_000, "sse#1 headers");
      holder.abort = s1.abort;
      expect(s1.status).toBe(200);
      if (seen.length >= 3 && abortAt < 0) {
        abortAt = seen[2].durable?.seq ?? -1;
        s1.abort();
      }
      await s1.done;
      expect(abortAt, `saw ${seen.length} events`).toBeGreaterThan(0);

      // 5. resume from the exact seq we stopped at; wait for settle.
      const resumed: Ev[] = [];
      const waiter = settleWaiter(8000);
      const s2 = await withTimeout(
        client.sse(`/api/session/${sid}/event?after=${abortAt}`, (e) => {
          const ev = parse(e.data);
          resumed.push(ev);
          waiter.arm();
          log(`  sse#2 seq=${ev.durable?.seq} ${ev.type}`);
        }),
        30_000,
        "sse#2 headers",
      );
      await waiter.settled;
      s2.abort();
      await s2.done;
      const seqs = resumed.map((e) => e.durable?.seq ?? -1);
      expect(seqs[0], `resume starts at ${abortAt + 1}`).toBe(abortAt + 1);
      expect(
        seqs.every((s, i) => i === 0 || s === seqs[i - 1] + 1),
        `no gaps/dups (${seqs.length} events, ${seqs[0]}..${seqs.at(-1)})`,
      ).toBe(true);
      const ended = [...seen, ...resumed].find(
        (e) => e.type === "session.next.text.ended",
      );
      const finalText =
        typeof ended?.data?.text === "string" ? ended.data.text : "";
      expect(
        finalText.trim(),
        `text.ended payload: ${JSON.stringify(ended?.data)}`,
      ).toMatch(/^pong[.!]?$/i);
      log(`final text ${JSON.stringify(finalText)}`);

      // 6. history pagination agrees with the stream.
      const hist = await client.request(
        "GET",
        `/api/session/${sid}/history?after=${abortAt}&limit=100`,
      );
      expect(hist.status, hist.text.slice(0, 200)).toBe(200);
      const hseqs = (hist.json() as { data: Ev[] }).data.map(
        (e) => e.durable?.seq,
      );
      expect(hseqs[0]).toBe(abortAt + 1);
      expect(hseqs).toHaveLength(seqs.length);
      log("history matches stream");

      // 7. v1-route delete so the scratch session leaves no trace.
      const del = await client.request("DELETE", `/session/${sid}`);
      expect(del.status, del.text.slice(0, 200)).toBe(200);
      log(`deleted ${sid}`);
      sid = null;
    } finally {
      if (sid !== null && client !== null) {
        await client.request("DELETE", `/session/${sid}`).catch(() => {});
      }
      console.log(
        `E2E iroh-http server log tail:\n${serverLog.slice(-20).join("\n")}`,
      );
      await client?.close().catch(() => {});
      await server?.stop().catch(() => {});
      await host.stop().catch(() => {});
      await ep?.close().catch(() => {});
      rmSync(home, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
