import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BiStream, Endpoint, EndpointAddr } from "@number0/iroh";
import { IROH_TCP_ALPN } from "@thinkite/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { fingerprintFromPubkeyB64, loadOrCreateIdentity } from "./identity.ts";
import { IrohPeerServer } from "./iroh-peer-server.ts";
import { KnownClients } from "./known-clients.ts";

/**
 * Full-wire tests for `thinkite/tcp/1`: a second iroh endpoint plays the
 * phone (what react-native-iroh-ffi's `forwardTcp` does per accepted TCP
 * connection: open a bi-stream, write the port, then the bytes), and a
 * plain TCP server on the Mac's loopback plays the dev server.
 */

const ALPN_BYTES = Array.from(Buffer.from(IROH_TCP_ALPN));

function dialAddr(server: IrohPeerServer): EndpointAddr {
  const addr = server.endpointAddr();
  const direct = addr.directAddresses();
  const loopback = direct
    .map((a) => a.slice(a.lastIndexOf(":")))
    .map((port) => `127.0.0.1${port}`);
  return new EndpointAddr(addr.id(), null, [...direct, ...loopback]);
}

function portHeader(port: number): number[] {
  return [port >> 8, port & 0xff];
}

async function readAll(bi: BiStream): Promise<string> {
  return Buffer.from(await bi.recv.readToEnd(1 << 20)).toString();
}

/** A dev-server stand-in: answers each connection with "echo:" + what it
 *  read, once the client half-closes. */
function startEchoServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c: Buffer) => chunks.push(c));
    socket.on("end", () => socket.end(`echo:${Buffer.concat(chunks)}`));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error();
      resolve({ server, port: address.port });
    });
  });
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(paired: boolean) {
  const home = mkdtempSync(join(tmpdir(), "iroh-tcp-test-"));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const b = Endpoint.builder();
  b.applyMinimal();
  b.secretKey(Array.from(randomBytes(32)));
  const ep = await b.bind();
  cleanups.push(() => ep.close());
  const pubkeyB64 = Buffer.from(Uint8Array.from(ep.id().toBytes())).toString(
    "base64url",
  );
  const knownClients = KnownClients.load(home);
  if (paired) {
    knownClients.add({
      fingerprint: fingerprintFromPubkeyB64(pubkeyB64),
      publicKeyB64: pubkeyB64,
      pairedAt: Date.now(),
    });
  }
  const logs: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const server = new IrohPeerServer({
    identity: loadOrCreateIdentity(home),
    knownClients,
    preset: "minimal",
    log: (event, data) => logs.push({ event, data }),
  });
  await server.start();
  cleanups.push(() => server.stop());
  return { ep, server, logs };
}

describe("IrohPeerServer TCP ALPN", () => {
  it("carries each stream to the port its header names", async () => {
    const { ep, server } = await setup(true);
    const a = await startEchoServer();
    const b = await startEchoServer();
    cleanups.push(
      () => void a.server.close(),
      () => void b.server.close(),
    );

    const conn = await ep.connect(dialAddr(server), ALPN_BYTES);
    const roundtrip = async (port: number, text: string) => {
      const bi = await conn.openBi();
      await bi.send.writeAll([...portHeader(port), ...Buffer.from(text)]);
      await bi.send.finish();
      return readAll(bi);
    };
    // Two ports at once over one connection.
    const [ra, rb] = await Promise.all([
      roundtrip(a.port, "to a"),
      roundtrip(b.port, "to b"),
    ]);
    expect(ra).toBe("echo:to a");
    expect(rb).toBe("echo:to b");

    await expect.poll(() => server.tcpTunnelCounts().sockets).toBe(0);
    conn.close(0n, []);
    await expect.poll(() => server.tcpTunnelCounts().connections).toBe(0);
  });

  it("ends the stream when nothing listens on the port", async () => {
    const { ep, server, logs } = await setup(true);
    const { server: probe, port } = await startEchoServer();
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const conn = await ep.connect(dialAddr(server), ALPN_BYTES);
    const bi = await conn.openBi();
    await bi.send.writeAll(portHeader(port));
    await expect(bi.recv.readToEnd(1024)).rejects.toThrow();
    await expect
      .poll(() => logs.find((l) => l.event === "iroh.tcp.socket_closed"))
      .toMatchObject({
        data: { port, reason: expect.stringMatching(/ECONNREFUSED/) },
      });
    conn.close(0n, []);
  });

  it("closes an unknown peer at the shared gate", async () => {
    const { ep, server, logs } = await setup(false);
    const conn = await ep.connect(dialAddr(server), ALPN_BYTES);
    await conn.closed();
    expect(logs.some((l) => l.event === "iroh.tcp.rejected_unknown")).toBe(
      true,
    );
    expect(server.tcpTunnelCounts().connections).toBe(0);
  });
});
