import {
  createHash,
  sign as cryptoSign,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClientAuthTranscript,
  type ClientAuthFrame,
  type ClientHelloFrame,
  HANDSHAKE_VERSION,
  type ServerHelloFrame,
  type TranscriptInput,
} from "@sidecodeapp/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { loadOrCreateIdentity } from "./identity.js";
import { KnownClients } from "./known-clients.js";
import { PairingService } from "./pairing.js";
import { type CommandHandler, WebSocketServer } from "./ws-server.js";

interface MockClient {
  publicKeyB64: string;
  privateKey: KeyObject;
  fingerprint: string;
}

function makeMockClient(): MockClient {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const fingerprint = createHash("sha256")
    .update(Buffer.from(jwk.x, "base64url"))
    .digest("hex")
    .slice(0, 16);
  return { publicKeyB64: jwk.x, privateKey, fingerprint };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextFrame<T = unknown>(ws: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMsg = (data: Buffer | string) => {
      ws.off("close", onClose);
      try {
        resolve(JSON.parse(data.toString()) as T);
      } catch (err) {
        reject(err);
      }
    };
    const onClose = (code: number, reason: Buffer) => {
      ws.off("message", onMsg);
      reject(new Error(`closed before frame: ${code} ${reason.toString()}`));
    };
    ws.once("message", onMsg);
    ws.once("close", onClose);
  });
}

function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code, reason) =>
      resolve({ code, reason: reason.toString() }),
    );
  });
}

function buildAuth(
  serverHello: ServerHelloFrame,
  hello: ClientHelloFrame,
  client: MockClient,
): ClientAuthFrame {
  const input: TranscriptInput = {
    sessionId: hello.sessionId,
    protocolVersion: HANDSHAKE_VERSION,
    mode: hello.mode,
    keyEpoch: serverHello.keyEpoch,
    daemonFingerprint: serverHello.daemonFingerprint,
    clientFingerprint: hello.clientFingerprint,
    daemonIdentityPublicKey: serverHello.daemonIdentityPublicKey,
    clientIdentityPublicKey: hello.clientIdentityPublicKey,
    clientNonce: hello.clientNonce,
    serverNonce: serverHello.serverNonce,
    expiresAt: serverHello.expiresAt,
  };
  const sig = cryptoSign(
    null,
    buildClientAuthTranscript(input),
    client.privateKey,
  );
  return {
    type: "client.auth",
    v: HANDSHAKE_VERSION,
    sessionId: hello.sessionId,
    clientFingerprint: client.fingerprint,
    keyEpoch: serverHello.keyEpoch,
    clientSignature: Buffer.from(sig).toString("base64url"),
  };
}

describe("WebSocketServer", () => {
  let home: string;
  let server: WebSocketServer | null = null;
  let url: string;
  let pairing: PairingService;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "sidecode-ws-test-"));
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    pairing = new PairingService(identity, known);
    server = new WebSocketServer({
      pairing,
      port: 0, // OS-assigned
      host: "127.0.0.1",
      authTimeoutMs: 500, // short for tests
      heartbeatIntervalMs: 60_000, // disable for unit tests
    });
    const bound = await server.start();
    url = `ws://${bound.host}:${bound.port}`;
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    rmSync(home, { recursive: true, force: true });
  });

  it("server.address exposes the actually-bound port", () => {
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
  });

  it("happy path: full handshake authenticates the client", async () => {
    const client = makeMockClient();
    const offer = pairing.createOffer("test");
    const sessionId = `int-${Date.now()}`;

    const ws = await connect(url);
    const hello: ClientHelloFrame = {
      type: "client.hello",
      v: HANDSHAKE_VERSION,
      sessionId,
      mode: "qr_bootstrap",
      clientFingerprint: client.fingerprint,
      clientIdentityPublicKey: client.publicKeyB64,
      clientNonce: randomBytes(32).toString("base64url"),
      offerExpiresAt: offer.expiresAt,
      offerDaemonFingerprint: offer.daemonFingerprint,
    };
    ws.send(JSON.stringify(hello));

    const serverHello = await nextFrame<ServerHelloFrame>(ws);
    expect(serverHello.type).toBe("server.hello");
    expect(serverHello.sessionId).toBe(sessionId);
    expect(serverHello.clientNonce).toBe(hello.clientNonce);

    ws.send(JSON.stringify(buildAuth(serverHello, hello, client)));
    const ready = await nextFrame<{ type: string; daemonFingerprint: string }>(
      ws,
    );
    expect(ready.type).toBe("server.ready");

    expect(server?.authenticatedCount()).toBe(1);
    ws.close();
  });

  it("auth timeout: connection that sends nothing gets closed", async () => {
    const ws = await connect(url);
    const closePromise = nextClose(ws);
    // Don't send anything. authTimeoutMs is 500.
    const closed = await closePromise;
    expect(closed.code).toBe(4001);
    expect(closed.reason).toBe("auth timeout");
  });

  it("rejects malformed JSON", async () => {
    const ws = await connect(url);
    const framePromise = nextFrame<{ code: string }>(ws);
    ws.send("not json at all");
    const reject = await framePromise;
    expect(reject.code).toBe("internal");
    const closed = await nextClose(ws);
    expect(closed.code).toBe(4002);
  });

  it("rejects ping frame at wait_hello stage (must be client.hello)", async () => {
    const ws = await connect(url);
    const framePromise = nextFrame<{ type: string; code: string }>(ws);
    ws.send(JSON.stringify({ type: "ping", t: Date.now() }));
    const reject = await framePromise;
    expect(reject.type).toBe("handshake.reject");
    expect(reject.code).toBe("internal");
    const closed = await nextClose(ws);
    expect(closed.code).toBe(4003);
  });

  it("rejects qr_bootstrap missing offer-echo fields", async () => {
    const client = makeMockClient();
    const ws = await connect(url);
    const framePromise = nextFrame<{ type: string; code: string }>(ws);
    ws.send(
      JSON.stringify({
        type: "client.hello",
        v: HANDSHAKE_VERSION,
        sessionId: "any-uuid",
        mode: "qr_bootstrap",
        clientFingerprint: client.fingerprint,
        clientIdentityPublicKey: client.publicKeyB64,
        clientNonce: randomBytes(32).toString("base64url"),
        // offerExpiresAt / offerDaemonFingerprint missing
      } satisfies ClientHelloFrame),
    );
    const reject = await framePromise;
    expect(reject.type).toBe("handshake.reject");
    expect(reject.code).toBe("internal");
    const closed = await nextClose(ws);
    expect(closed.code).toBe(4004);
  });

  it("rejects subscribe sent before authentication", async () => {
    const ws = await connect(url);
    const framePromise = nextFrame<{ type: string; code: string }>(ws);
    ws.send(JSON.stringify({ type: "subscribe", sessionId: "x" }));
    const reject = await framePromise;
    expect(reject.code).toBe("internal");
  });

  it("client.auth without a prior client.hello → wait_hello stage rejection", async () => {
    const ws = await connect(url);
    const framePromise = nextFrame<{ code: string }>(ws);
    ws.send(
      JSON.stringify({
        type: "client.auth",
        v: HANDSHAKE_VERSION,
        sessionId: "ghost",
        clientFingerprint: "x".repeat(16),
        keyEpoch: 1,
        clientSignature: "AAAA",
      } satisfies ClientAuthFrame),
    );
    // Connection is in wait_hello, so client.auth is the wrong frame here.
    const reject = await framePromise;
    expect(reject.code).toBe("internal");
  });

  it("two concurrent connections can pair off the same offer", async () => {
    const a = makeMockClient();
    const b = makeMockClient();
    const offer = pairing.createOffer("shared");

    const wsA = await connect(url);
    const wsB = await connect(url);

    const helloA: ClientHelloFrame = {
      type: "client.hello",
      v: HANDSHAKE_VERSION,
      sessionId: `a-${Date.now()}`,
      mode: "qr_bootstrap",
      clientFingerprint: a.fingerprint,
      clientIdentityPublicKey: a.publicKeyB64,
      clientNonce: randomBytes(32).toString("base64url"),
      offerExpiresAt: offer.expiresAt,
      offerDaemonFingerprint: offer.daemonFingerprint,
    };
    const helloB: ClientHelloFrame = {
      ...helloA,
      sessionId: `b-${Date.now()}`,
      clientFingerprint: b.fingerprint,
      clientIdentityPublicKey: b.publicKeyB64,
      clientNonce: randomBytes(32).toString("base64url"),
    };

    const aReply = nextFrame<ServerHelloFrame>(wsA);
    const bReply = nextFrame<ServerHelloFrame>(wsB);
    wsA.send(JSON.stringify(helloA));
    wsB.send(JSON.stringify(helloB));
    const [shA, shB] = await Promise.all([aReply, bReply]);

    const aReady = nextFrame<{ type: string }>(wsA);
    const bReady = nextFrame<{ type: string }>(wsB);
    wsA.send(JSON.stringify(buildAuth(shA, helloA, a)));
    wsB.send(JSON.stringify(buildAuth(shB, helloB, b)));
    const [readyA, readyB] = await Promise.all([aReady, bReady]);

    expect(readyA.type).toBe("server.ready");
    expect(readyB.type).toBe("server.ready");
    expect(server?.authenticatedCount()).toBe(2);
    wsA.close();
    wsB.close();
  });

  it("trusted_reconnect: known client can re-authenticate", async () => {
    const client = makeMockClient();
    // First pair via qr_bootstrap.
    {
      const offer = pairing.createOffer("test");
      const ws = await connect(url);
      const hello: ClientHelloFrame = {
        type: "client.hello",
        v: HANDSHAKE_VERSION,
        sessionId: `boot-${Date.now()}`,
        mode: "qr_bootstrap",
        clientFingerprint: client.fingerprint,
        clientIdentityPublicKey: client.publicKeyB64,
        clientNonce: randomBytes(32).toString("base64url"),
        offerExpiresAt: offer.expiresAt,
        offerDaemonFingerprint: offer.daemonFingerprint,
      };
      ws.send(JSON.stringify(hello));
      const sh = await nextFrame<ServerHelloFrame>(ws);
      ws.send(JSON.stringify(buildAuth(sh, hello, client)));
      await nextFrame<{ type: string }>(ws);
      ws.close();
    }

    // Then reconnect via trusted_reconnect (no QR needed).
    {
      const ws = await connect(url);
      const hello: ClientHelloFrame = {
        type: "client.hello",
        v: HANDSHAKE_VERSION,
        sessionId: "reconnect-1",
        mode: "trusted_reconnect",
        clientFingerprint: client.fingerprint,
        clientIdentityPublicKey: client.publicKeyB64,
        clientNonce: randomBytes(32).toString("base64url"),
      };
      ws.send(JSON.stringify(hello));
      const sh = await nextFrame<ServerHelloFrame>(ws);
      expect(sh.mode).toBe("trusted_reconnect");
      ws.send(JSON.stringify(buildAuth(sh, hello, client)));
      const ready = await nextFrame<{ type: string }>(ws);
      expect(ready.type).toBe("server.ready");
      ws.close();
    }
  });

  it("stop() closes outstanding connections", async () => {
    const ws = await connect(url);
    const closePromise = nextClose(ws);
    await server?.stop();
    server = null;
    const closed = await closePromise;
    // Code 1001 is "going away"; test the connection is closed cleanly.
    expect(closed.code).toBeGreaterThanOrEqual(1000);
  });
});

describe("WebSocketServer authenticated dispatch", () => {
  let home: string;
  let server: WebSocketServer | null = null;
  let url: string;
  let pairing: PairingService;

  /** Performs a full qr_bootstrap handshake and returns the open authenticated ws. */
  async function authenticate(): Promise<WebSocket> {
    const client = makeMockClient();
    const offer = pairing.createOffer("dispatch");
    const ws = await connect(url);
    const hello: ClientHelloFrame = {
      type: "client.hello",
      v: HANDSHAKE_VERSION,
      sessionId: `disp-${Math.random().toString(36).slice(2)}`,
      mode: "qr_bootstrap",
      clientFingerprint: client.fingerprint,
      clientIdentityPublicKey: client.publicKeyB64,
      clientNonce: randomBytes(32).toString("base64url"),
      offerExpiresAt: offer.expiresAt,
      offerDaemonFingerprint: offer.daemonFingerprint,
    };
    ws.send(JSON.stringify(hello));
    const sh = await nextFrame<ServerHelloFrame>(ws);
    ws.send(JSON.stringify(buildAuth(sh, hello, client)));
    await nextFrame<{ type: string }>(ws); // server.ready
    return ws;
  }

  /** Build server with a custom commandHandler. */
  async function startWith(handler: CommandHandler): Promise<void> {
    server = new WebSocketServer({
      pairing,
      commandHandler: handler,
      port: 0,
      host: "127.0.0.1",
      authTimeoutMs: 1000,
      heartbeatIntervalMs: 60_000,
    });
    const bound = await server.start();
    url = `ws://${bound.host}:${bound.port}`;
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-ws-disp-"));
    const identity = loadOrCreateIdentity(home);
    const known = KnownClients.load(home);
    pairing = new PairingService(identity, known);
  });

  afterEach(async () => {
    await server?.stop();
    server = null;
    rmSync(home, { recursive: true, force: true });
  });

  it("calls commandHandler with the parsed command + send context", async () => {
    const calls: Array<{
      cmdType: string;
      cliSessionId?: string;
      fingerprint: string;
    }> = [];
    await startWith(async (cmd, ctx) => {
      calls.push({
        cmdType: cmd.type,
        cliSessionId: "cliSessionId" in cmd ? cmd.cliSessionId : undefined,
        fingerprint: ctx.fingerprint,
      });
      if (cmd.type === "continueOnDesktop") {
        ctx.send({
          type: "continueOnDesktop.response",
          requestId: cmd.requestId,
          ok: true,
        });
      }
    });
    const ws = await authenticate();
    const reply = nextFrame<{ type: string; requestId: string; ok: boolean }>(
      ws,
    );
    ws.send(
      JSON.stringify({
        type: "continueOnDesktop",
        requestId: "req-1",
        cliSessionId: "abc",
      }),
    );
    const res = await reply;
    expect(res.type).toBe("continueOnDesktop.response");
    expect(res.requestId).toBe("req-1");
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cmdType).toBe("continueOnDesktop");
    expect(calls[0]?.cliSessionId).toBe("abc");
    expect(calls[0]?.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    ws.close();
  });

  it("emits an internal-error frame when the handler throws", async () => {
    await startWith(() => {
      throw new Error("boom");
    });
    const ws = await authenticate();
    const reply = nextFrame<{
      type: string;
      code: string;
      requestId?: string;
      message: string;
    }>(ws);
    ws.send(
      JSON.stringify({
        type: "continueOnDesktop",
        requestId: "req-2",
        cliSessionId: "abc",
      }),
    );
    const res = await reply;
    expect(res.type).toBe("error");
    expect(res.code).toBe("internal");
    expect(res.requestId).toBe("req-2");
    expect(res.message).toMatch(/boom/);
    ws.close();
  });

  it("emits an internal-error frame when an async handler rejects", async () => {
    await startWith(async () => {
      throw new Error("async boom");
    });
    const ws = await authenticate();
    const reply = nextFrame<{ code: string; message: string }>(ws);
    ws.send(
      JSON.stringify({
        type: "continueOnDesktop",
        requestId: "req-3",
        cliSessionId: "abc",
      }),
    );
    const res = await reply;
    expect(res.code).toBe("internal");
    expect(res.message).toMatch(/async boom/);
    ws.close();
  });

  it("responds to ping with pong (no handler invocation)", async () => {
    let handlerCalls = 0;
    await startWith(() => {
      handlerCalls += 1;
    });
    const ws = await authenticate();
    const reply = nextFrame<{ type: string; t: number; echoT: number }>(ws);
    const t = Date.now();
    ws.send(JSON.stringify({ type: "ping", t }));
    const pong = await reply;
    expect(pong.type).toBe("pong");
    expect(pong.echoT).toBe(t);
    expect(handlerCalls).toBe(0);
    ws.close();
  });

  it("ctx.onDisconnect callbacks fire when the connection closes", async () => {
    const fired: string[] = [];
    await startWith((cmd, ctx) => {
      if (cmd.type !== "continueOnDesktop") return;
      ctx.onDisconnect(() => fired.push("a"));
      ctx.onDisconnect(() => fired.push("b"));
      ctx.send({
        type: "continueOnDesktop.response",
        requestId: cmd.requestId,
        ok: true,
      });
    });
    const ws = await authenticate();
    const reply = nextFrame<{ type: string }>(ws);
    ws.send(
      JSON.stringify({
        type: "continueOnDesktop",
        requestId: "req-cb-1",
        cliSessionId: "abc",
      }),
    );
    await reply;
    expect(fired).toEqual([]);
    ws.close();
    // Wait for server-side close handler to fire callbacks.
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toEqual(["a", "b"]);
  });

  it("ctx.onDisconnect: an exception in one cb does not skip the rest", async () => {
    const fired: string[] = [];
    await startWith((cmd, ctx) => {
      if (cmd.type !== "continueOnDesktop") return;
      ctx.onDisconnect(() => {
        fired.push("first");
        throw new Error("first cb blew up");
      });
      ctx.onDisconnect(() => fired.push("second"));
      ctx.send({
        type: "continueOnDesktop.response",
        requestId: cmd.requestId,
        ok: true,
      });
    });
    const ws = await authenticate();
    const reply = nextFrame<{ type: string }>(ws);
    ws.send(
      JSON.stringify({
        type: "continueOnDesktop",
        requestId: "req-cb-2",
        cliSessionId: "abc",
      }),
    );
    await reply;
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(fired).toEqual(["first", "second"]);
  });

  it("authenticated commands are silently dropped when no handler configured", async () => {
    // Server WITHOUT a handler.
    server = new WebSocketServer({
      pairing,
      port: 0,
      host: "127.0.0.1",
      authTimeoutMs: 1000,
      heartbeatIntervalMs: 60_000,
    });
    const bound = await server.start();
    url = `ws://${bound.host}:${bound.port}`;

    const ws = await authenticate();
    ws.send(
      JSON.stringify({
        type: "continueOnDesktop",
        requestId: "req-4",
        cliSessionId: "abc",
      }),
    );
    // Wait a tick to confirm no response comes back (timeout-then-resolve dance).
    const got = await Promise.race([
      nextFrame<unknown>(ws).then((f) => ({ frame: f })),
      new Promise((r) => setTimeout(() => r({ frame: null }), 200)),
    ]);
    expect((got as { frame: unknown }).frame).toBeNull();
    ws.close();
  });
});
