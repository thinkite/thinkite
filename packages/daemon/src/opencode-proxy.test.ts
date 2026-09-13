import { once } from "node:events";
import http, { type IncomingMessage, type Server } from "node:http";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { createProxyServer } from "./opencode-proxy.ts";

/**
 * The proxy is non-listening: a real `http.createServer` upstream plus an
 * in-memory duplex pair standing in for the iroh bi-stream the daemon feeds
 * it. Same bytes, same semantics as the tunnel — no iroh binding needed.
 */

const USERNAME = "opencode";
const PASSWORD = "s3cret";
const EXPECTED_AUTH = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn();
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as { port: number }).port);
    });
  });
}

function upstreamConnection(baseUrl: string) {
  return async () => ({
    baseUrl,
    username: USERNAME,
    password: PASSWORD,
    version: "2.0.2",
  });
}

/** Two Duplexes wired push-to-push — one end per side of the proxy. */
function duplexPair(): [Duplex, Duplex] {
  let left!: Duplex;
  let right!: Duplex;
  const make = (peer: () => Duplex): Duplex =>
    new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        peer().push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        peer().push(null);
        cb();
      },
      destroy(err, cb) {
        peer().destroy();
        cb(err);
      },
    });
  left = make(() => right);
  right = make(() => left);
  return [left, right];
}

/** Drive one HTTP request through the proxy as if it arrived over iroh. */
async function requestThroughProxy(
  proxy: http.Server,
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<IncomingMessage> {
  const [clientSock, proxySock] = duplexPair();
  proxy.emit("connection", proxySock);
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = http.request(
      {
        createConnection: () => clientSock as never,
        method,
        path,
        headers: { host: "daemon.iroh", ...headers },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

function readAll(res: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
    }),
  ]);
}

describe("createProxyServer", () => {
  it("injects Basic auth and strips accept-encoding upstream", async () => {
    const seen: { headers?: http.IncomingHttpHeaders } = {};
    const upstream = http.createServer((req, res) => {
      seen.headers = req.headers;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(upstream);
    cleanups.push(() => upstream.close());
    const proxy = createProxyServer({
      getUpstream: upstreamConnection(`http://127.0.0.1:${port}`),
    });
    cleanups.push(() => proxy.close());

    const res = await requestThroughProxy(proxy, "GET", "/global/health", {
      authorization: "Bearer leaked",
      "accept-encoding": "gzip, br",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(await readAll(res))).toEqual({ ok: true });

    expect(seen.headers?.authorization).toBe(EXPECTED_AUTH);
    expect(seen.headers?.["accept-encoding"]).toBeUndefined();
    expect(seen.headers?.host).toBe(`127.0.0.1:${port}`);
  });

  it("passes SSE chunks through without buffering", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write("data: one\n\n");
      void secondGate.then(() => {
        res.write("data: two\n\n");
        res.end();
      });
    });
    const port = await listen(upstream);
    cleanups.push(() => upstream.close());
    const proxy = createProxyServer({
      getUpstream: upstreamConnection(`http://127.0.0.1:${port}`),
    });
    cleanups.push(() => proxy.close());

    const res = await requestThroughProxy(proxy, "GET", "/event", {
      accept: "text/event-stream",
    });
    expect(res.statusCode).toBe(200);
    // The first chunk must arrive while the upstream still holds the
    // response open — a buffering proxy would deadlock until the timeout.
    const first = await withTimeout(
      once(res, "data").then(([chunk]) => Buffer.from(chunk).toString()),
      2000,
      "first SSE chunk",
    );
    expect(first).toContain("data: one");

    releaseSecond();
    const rest = await readAll(res);
    expect(rest).toContain("data: two");
  });

  it("destroys the upstream request when the client socket closes", async () => {
    let upstreamClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": open\n\n");
      res.on("close", () => upstreamClosed());
    });
    const port = await listen(upstream);
    cleanups.push(() => upstream.close());
    const proxy = createProxyServer({
      getUpstream: upstreamConnection(`http://127.0.0.1:${port}`),
    });
    cleanups.push(() => proxy.close());

    const res = await requestThroughProxy(proxy, "GET", "/hold", {
      accept: "text/event-stream",
    });
    await withTimeout(once(res, "data"), 2000, "response open");
    res.destroy();

    await withTimeout(closed, 2000, "upstream close after client reset");
  });

  it("answers 502 with a JSON body when opencode cannot start", async () => {
    const proxy = createProxyServer({
      getUpstream: async () => {
        throw new Error("opencode server did not become healthy in 30s");
      },
    });
    cleanups.push(() => proxy.close());

    const res = await requestThroughProxy(proxy, "GET", "/global/health");
    expect(res.statusCode).toBe(502);
    expect(res.headers["content-type"]).toContain("application/json");
    const parsed = JSON.parse(await readAll(res)) as {
      error: string;
      message: string;
    };
    expect(parsed.error).toBe("opencode_unavailable");
    expect(parsed.message).toContain("healthy");
  });
});
