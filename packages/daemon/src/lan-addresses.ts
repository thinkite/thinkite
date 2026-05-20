import { networkInterfaces } from "node:os";

/**
 * Address-list construction for pair offers that need to reach a physical
 * iPhone. Shared between `sidecode pair` (one-shot CLI print) and the
 * menu bar Pair window (long-running, re-mints on every QR refresh).
 *
 * Ordering matters: the iOS client tries the URLs sequentially with a
 * per-attempt timeout and the first one to handshake wins. So we put the
 * fastest-likely path first.
 *
 *   1. RFC1918 LAN (192.168 / 10 / 172.16-31) — same Wi-Fi, no relay,
 *      lowest latency.
 *   2. Tailscale CGNAT (100.64.0.0/10) — works across networks but adds
 *      DERP / NAT-traversal overhead when the LAN path also exists, so
 *      only used as fallback.
 *   3. Anything else non-internal — corporate VPN ranges etc.
 *   4. Loopback last — keeps the same offer usable from a simulator on
 *      this same Mac (which can also reach the LAN IP, but loopback is
 *      faster and immune to router-level firewall rules).
 */
export function buildLanAddresses(
  port: number,
  loopbackHost = "127.0.0.1",
): string[] {
  const lan = prioritizedLanIpv4s().map((h) => `ws://${h}:${port}`);
  const loopback = `ws://${loopbackHost}:${port}`;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const addr of [...lan, loopback]) {
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

/**
 * All non-internal IPv4 addresses on this Mac, ordered: RFC1918 first
 * (192.168.x, 10.x, 172.16-31.x) then Tailscale CGNAT (100.64.0.0/10)
 * then everything else. Returns `[]` if none found.
 */
export function prioritizedLanIpv4s(): string[] {
  const found: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const ifc of ifaces ?? []) {
      if (ifc.family !== "IPv4" || ifc.internal) continue;
      found.push(ifc.address);
    }
  }
  found.sort((a, b) => addressPriority(a) - addressPriority(b));
  return found;
}

function addressPriority(ip: string): number {
  if (isRfc1918(ip)) return 0;
  if (isTailscaleCgnat(ip)) return 1;
  return 2;
}

function isRfc1918(ip: string): boolean {
  if (ip.startsWith("192.168.")) return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("172.")) {
    const second = Number(ip.split(".")[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

function isTailscaleCgnat(ip: string): boolean {
  if (!ip.startsWith("100.")) return false;
  const second = Number(ip.split(".")[1]);
  return second >= 64 && second <= 127;
}
