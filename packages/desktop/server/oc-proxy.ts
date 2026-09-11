// Same-origin reverse proxy to the daemon-owned `opencode serve`:
// `/oc/*` on this server → the opencode server, with `/oc` stripped and
// Basic auth injected. Credentials never reach the renderer — the
// renderer builds its oc-client with `baseUrl: `${location.origin}/oc``.
//
// Approach ported from `spikes/oc-proxy/proxy.ts`: stream bodies both ways
// (SSE passes through untouched), drop `accept-encoding` so SSE stays
// unbuffered, flush headers on event streams, and drop the upstream
// request when the client goes away. Deliberately NOT the spike's
// whole-server wrapper or its QUIC half-open settings — this mounts into
// the existing node http server, whose defaults are fine for plain
// request/response + SSE streaming.

import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export interface OcUpstream {
  baseUrl: string;
  username: string;
  password: string;
}

/** Strip the `/oc` mount prefix (`/oc` → `/`, `/oc/api/x` → `/api/x`). */
export function stripOcPrefix(url: string): string {
  if (url === "/oc") return "/";
  if (url.startsWith("/oc/")) return url.slice(3);
  return url;
}

export function handleOcProxy(
  req: IncomingMessage,
  res: ServerResponse,
  upstream: OcUpstream,
): void {
  let target: URL;
  try {
    target = new URL(stripOcPrefix(req.url ?? "/"), upstream.baseUrl);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad request");
    return;
  }
  const auth = `Basic ${Buffer.from(`${upstream.username}:${upstream.password}`).toString("base64")}`;
  const headers: Record<string, string | string[] | undefined> = {
    ...req.headers,
  };
  delete headers.authorization;
  delete headers["accept-encoding"];
  headers.authorization = auth;
  headers.host = target.host;
  const up = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
    },
    (ures) => {
      res.writeHead(ures.statusCode ?? 502, ures.headers);
      const contentType = ures.headers["content-type"];
      if (
        typeof contentType === "string" &&
        contentType.includes("text/event-stream")
      ) {
        res.flushHeaders();
      }
      ures.pipe(res);
    },
  );
  up.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  // Client went away (navigated, aborted) → drop the upstream request so
  // a tailed SSE stream doesn't linger on the opencode server.
  res.on("close", () => up.destroy());
  req.pipe(up);
}
