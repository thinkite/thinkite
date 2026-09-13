// HTTP reverse proxy: non-listening http.Server whose connections are fed
// externally (iroh streams, in-memory duplexes). Injects Basic auth toward
// the opencode server so the password never leaves the daemon. Streams
// bodies both ways, so SSE passes through untouched.
import http from "node:http";
import type { OpencodeConnection } from "./opencode/registry.ts";

export interface ProxyOptions {
  /**
   * Resolve the opencode server to proxy to. Called per request so a
   * replaced service (upgrade) is picked up without a restart; a rejection
   * (no registered service) becomes a 502 JSON response.
   */
  getUpstream: () => Promise<OpencodeConnection>;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export function createProxyServer(opts: ProxyOptions): http.Server {
  const server = http.createServer((req, res) => {
    void handleRequest(req, res).catch((err: unknown) => {
      opts.log?.("iroh.http.proxy_error", {
        method: req.method,
        path: req.url,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const startedAt = Date.now();
    let upstream: OpencodeConnection;
    try {
      upstream = await opts.getUpstream();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.log?.("iroh.http.request", {
        method: req.method,
        path: req.url,
        status: 502,
        ms: Date.now() - startedAt,
        error: message,
      });
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
      }
      res.end(JSON.stringify({ error: "opencode_unavailable", message }));
      return;
    }

    const target = new URL(upstream.baseUrl);
    const auth =
      "Basic " +
      Buffer.from(`${upstream.username}:${upstream.password}`).toString(
        "base64",
      );
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.authorization;
    delete headers["accept-encoding"]; // keep SSE unbuffered
    headers.authorization = auth;
    headers.host = target.host;
    const up = http.request(
      {
        host: target.hostname,
        port: target.port,
        method: req.method,
        path: req.url,
        headers,
      },
      (ures) => {
        opts.log?.("iroh.http.request", {
          method: req.method,
          path: req.url,
          status: ures.statusCode ?? 502,
          ms: Date.now() - startedAt,
        });
        res.writeHead(ures.statusCode ?? 502, ures.headers);
        if (ures.headers["content-type"]?.includes("text/event-stream")) {
          res.flushHeaders();
        }
        ures.pipe(res);
      },
    );
    up.on("error", (err) => {
      opts.log?.("iroh.http.request", {
        method: req.method,
        path: req.url,
        status: 502,
        ms: Date.now() - startedAt,
        error: err.message,
      });
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    res.on("close", () => up.destroy()); // client went away → drop upstream (SSE)
    req.pipe(up);
  }

  server.keepAliveTimeout = 0; // never idle-close a stream ourselves
  // A QUIC client that finishes its send side after the request half-closes the
  // "socket"; Node's http server would otherwise end the connection before
  // responding (socketOnEnd → socket.end()), which is what the phone hit.
  (server as unknown as { httpAllowHalfOpen: boolean }).httpAllowHalfOpen =
    true;
  return server;
}
