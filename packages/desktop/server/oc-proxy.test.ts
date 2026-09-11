// Offline tests for the `/oc` reverse proxy: prefix stripping, Basic
// auth injection (credentials never come from the client), and SSE
// passthrough. No opencode server needed — a fake upstream asserts what
// the proxy sends.

import { createServer, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { handleOcProxy, stripOcPrefix } from "./oc-proxy.ts";

describe("stripOcPrefix", () => {
  it("strips the mount prefix, keeping path + query", () => {
    expect(stripOcPrefix("/oc")).toBe("/");
    expect(stripOcPrefix("/oc/")).toBe("/");
    expect(stripOcPrefix("/oc/api/session")).toBe("/api/session");
    expect(stripOcPrefix("/oc/session/ses_1")).toBe("/session/ses_1");
    expect(stripOcPrefix("/other")).toBe("/other");
  });
});

describe("handleOcProxy", () => {
  it("forwards with injected auth and streams SSE through", async () => {
    const seen: Array<{
      url?: string;
      auth?: string;
      encoding?: string;
    }> = [];
    const upstream: Server = createServer((req, res) => {
      seen.push({
        url: req.url,
        auth: req.headers.authorization,
        encoding: req.headers["accept-encoding"] as string | undefined,
      });
      if (req.url === "/api/event") {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        res.write('data: {"type":"ping"}\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const upstreamPort = (upstream.address() as { port: number }).port;

    const proxy: Server = createServer((req, res) => {
      handleOcProxy(req, res, {
        baseUrl: `http://127.0.0.1:${upstreamPort}`,
        username: "opencode",
        password: "s3cret",
      });
    });
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
      // No credentials from the client — and a wrong one is overridden.
      const res = await fetch(
        `http://127.0.0.1:${proxyPort}/oc/api/session?limit=1`,
        { headers: { authorization: "Basic bogus" } },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(seen[0]?.url).toBe("/api/session?limit=1");
      expect(seen[0]?.auth).toBe(
        `Basic ${Buffer.from("opencode:s3cret").toString("base64")}`,
      );
      expect(seen[0]?.encoding).toBeUndefined();

      // SSE passes through unbuffered as one stream.
      const sse = await fetch(`http://127.0.0.1:${proxyPort}/oc/api/event`, {
        headers: { accept: "text/event-stream" },
      });
      expect(sse.status).toBe(200);
      expect(sse.headers.get("content-type")).toContain("text/event-stream");
      expect(await sse.text()).toContain('"type":"ping"');
    } finally {
      proxy.close();
      upstream.close();
    }
  });
});
