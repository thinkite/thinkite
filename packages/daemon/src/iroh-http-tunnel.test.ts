import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Endpoint, EndpointAddr } from "@number0/iroh";
import { IROH_HTTP_ALPN } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import { fingerprintFromPubkeyB64, loadOrCreateIdentity } from "./identity.ts";
import { irohDuplex } from "./iroh-duplex.ts";
import { IrohPeerServer } from "./iroh-peer-server.ts";
import { KnownClients } from "./known-clients.ts";

/**
 * Full-wire dispatch tests: a real second iroh endpoint dials the server's
 * `thinkite/http/1` ALPN, and the bi-stream is driven by Node's http client
 * (the same shape `spikes/oc-proxy/client.ts` uses). No opencode host is
 * configured, so the tunnel's lazy upstream resolver fails and every
 * request exercises the 502 path — the point here is that the ALPN lands
 * in the tunnel at all, behind the same known_clients gate as RPC.
 */

const ALPN_BYTES = Array.from(Buffer.from(IROH_HTTP_ALPN));

function dialAddr(server: IrohPeerServer): EndpointAddr {
  const addr = server.endpointAddr();
  const direct = addr.directAddresses();
  const loopback = direct
    .map((a) => a.slice(a.lastIndexOf(":")))
    .map((port) => `127.0.0.1${port}`);
  return new EndpointAddr(addr.id(), null, [...direct, ...loopback]);
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

function requestOver(
  conn: Awaited<ReturnType<Endpoint["connect"]>>,
  method: string,
  path: string,
): Promise<http.IncomingMessage> {
  return conn.openBi().then((bi) => {
    const sock = irohDuplex(bi);
    return new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.request(
        {
          createConnection: () => sock as never,
          method,
          path,
          headers: { host: "daemon.iroh" },
        },
        resolve,
      );
      req.on("error", reject);
      req.end();
    });
  });
}

function readAll(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
}

describe("IrohPeerServer HTTP ALPN dispatch", () => {
  it("routes a paired HTTP connection into the tunnel (502 without opencode)", async () => {
    const home = mkdtempSync(join(tmpdir(), "iroh-http-test-"));
    const { ep, pubkeyB64 } = await makeClientEndpoint();
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const identity = loadOrCreateIdentity(home);
    const knownClients = KnownClients.load(home);
    knownClients.add({
      fingerprint: fingerprintFromPubkeyB64(pubkeyB64),
      publicKeyB64: pubkeyB64,
      pairedAt: Date.now(),
    });
    const server = new IrohPeerServer({
      identity,
      knownClients,
      preset: "minimal",
      log: (event, data) => logs.push({ event, data }),
    });
    await server.start();
    try {
      const conn = await ep.connect(dialAddr(server), ALPN_BYTES);
      const res = await requestOver(conn, "GET", "/global/health");
      expect(res.statusCode).toBe(502);
      const body = JSON.parse(await readAll(res)) as { error: string };
      expect(body.error).toBe("opencode_unavailable");

      await expect.poll(() => server.httpTunnelCount()).toBe(1);
      expect(logs.some((l) => l.event === "iroh.http.accepted")).toBe(true);
      expect(
        logs.filter((l) => l.event === "iroh.http.request").at(-1)?.data,
      ).toMatchObject({
        method: "GET",
        path: "/global/health",
        status: 502,
      });

      conn.close(0n, []);
      await expect.poll(() => server.httpTunnelCount()).toBe(0);
    } finally {
      await server.stop();
      await ep.close();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("closes an unknown HTTP peer at the shared gate", async () => {
    const home = mkdtempSync(join(tmpdir(), "iroh-http-test-"));
    const { ep } = await makeClientEndpoint();
    const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
    const identity = loadOrCreateIdentity(home);
    const knownClients = KnownClients.load(home);
    const server = new IrohPeerServer({
      identity,
      knownClients,
      preset: "minimal",
      isPairing: () => false,
      log: (event, data) => logs.push({ event, data }),
    });
    await server.start();
    try {
      const conn = await ep.connect(dialAddr(server), ALPN_BYTES);
      await conn.closed();
      expect(knownClients.list()).toHaveLength(0);
      expect(logs.some((l) => l.event === "iroh.http.rejected_unknown")).toBe(
        true,
      );
      expect(server.httpTunnelCount()).toBe(0);
    } finally {
      await server.stop();
      await ep.close();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
