// Which requests may reach the local server's routes: only Thinkite's own
// page. The server listens on a fixed loopback port, and loopback is not a
// boundary for a browser: any page the user opens (a tab in their browser,
// a site in the session panel's browser) can send a POST there, and a
// WebSocket isn't held to CORS at all. Without this, any page could open a
// shell through `/pty` or drive the agent through `/oc`.
//
//   - `Host` must name this server, so a domain rebound to 127.0.0.1
//     can't pass its own pages off as ours.
//   - `Origin`, when sent (every POST, every WebSocket, every cross-origin
//     fetch), must be the page's.
//   - `Sec-Fetch-Site`, when sent, must say same-origin (or a navigation
//     the user typed).
//
// A request with none of these headers is a local tool's (curl), which
// can reach the user's files anyway.

import type { IncomingHttpHeaders } from "node:http";

/** Allow requests from these page URLs (the packaged origin and, in dev,
 *  the Vite server the window loads, which forwards with `Host` kept). */
export function createRequestGuard(
  pageUrls: readonly string[],
): (headers: IncomingHttpHeaders) => boolean {
  const origins = new Set(pageUrls.map((u) => new URL(u).origin));
  const hosts = new Set([...origins].map((o) => new URL(o).host));
  return (headers) => {
    if (headers.host === undefined || !hosts.has(headers.host)) return false;
    if (headers.origin !== undefined && !origins.has(headers.origin))
      return false;
    const site = headers["sec-fetch-site"];
    return site === undefined || site === "same-origin" || site === "none";
  };
}
