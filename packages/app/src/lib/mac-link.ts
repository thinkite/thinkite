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

/** The same page on the phone's own localhost, where the forwarder for
 *  its port listens: the host becomes `localhost`, the rest stays. */
export function phonePage(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//localhost:${localPort(url)}${u.pathname}${u.search}${u.hash}`;
}

/** What tapping a link to the Mac's `port` tells the user when the phone
 *  cannot show it: no server of the agent's listens there, the port is
 *  taken on the phone, or the forwarder is not up (yet). */
export function macPageNotice(
  port: number,
  ports: readonly ForwardPort[],
  failure?: string,
): { title: string; message: string } {
  const server = ports.find((p) => p.port === port);
  if (server === undefined)
    return {
      title: "Not reachable from your phone",
      message: `This link points to your Mac itself, and no server the agent started is listening on port ${port}.`,
    };
  if (failure !== undefined)
    return {
      title: `Port ${port} is taken on this phone`,
      message: `"${server.name}" serves this page on your Mac, but something on the phone already listens on port ${port}, so it can't be brought over. (${failure})`,
    };
  return {
    title: `"${server.name}" isn't connected yet`,
    message: `It serves this page on your Mac at port ${port}. The phone connects to it while Thinkite is open and online; try again in a moment.`,
  };
}
