import type { ForwardPort } from "@thinkite/protocol";

/** The port of a page on the Mac itself (loopback or `*.localhost`), which
 *  the phone cannot reach directly. Undefined for any other host. */
export function localPort(url: string): number | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    host.startsWith("127.");
  if (!local) return undefined;
  return Number(u.port || (u.protocol === "https:" ? 443 : 80));
}

/** What tapping a link to the Mac's `port` tells the user, given the
 *  servers' ports: the phone has no port forwarding yet
 *  (docs/preview-tool-v1.md), so such a page opens on the Mac. */
export function macPageNotice(
  port: number,
  ports: readonly ForwardPort[],
): { title: string; message: string } {
  const server = ports.find((p) => p.port === port);
  return server === undefined
    ? {
        title: "Not reachable from your phone",
        message: `This link points to your Mac itself, and no server the agent started is listening on port ${port}.`,
      }
    : {
        title: `"${server.name}" runs on your Mac`,
        message: `It serves this page on port ${port}. Open the link in Thinkite on your Mac; opening it on the phone needs port forwarding, which is not here yet.`,
      };
}
