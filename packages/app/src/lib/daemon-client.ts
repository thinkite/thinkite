import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { bytesToBase64Url } from "./base64";
import {
  buildClientAuthTranscript,
  HANDSHAKE_VERSION,
  type HandshakeMode,
  type TranscriptInput,
} from "./handshake";
import type { ClientIdentity } from "./identity";

// SecureStore restricts keys to [A-Za-z0-9._-] — no slashes / colons.
const PAIRED_STORE_KEY = "sidecode_paired_daemon_v1";

/** What we save after a successful first pair so subsequent launches can
 *  trusted_reconnect without re-scanning a QR. */
export interface PairedDaemon {
  address: string; // ws://host:port
  fingerprint: string; // 16 hex chars
  identityPublicKey: string; // base64url
}

export interface PairOffer {
  v: number;
  daemonFingerprint: string;
  daemonIdentityPublicKey: string;
  daemonAddress: string;
  serviceName: string;
  expiresAt: number;
}

/** Decode a pair.offer payload (the base64url string from a QR / dev paste). */
export function decodePairOffer(b64: string): PairOffer {
  const padded = b64 + "===".slice(0, (4 - (b64.length % 4)) % 4);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  const json = atob(std);
  const offer = JSON.parse(json) as PairOffer;
  if (offer.v !== HANDSHAKE_VERSION) {
    throw new Error(`offer v=${offer.v} != HANDSHAKE_VERSION=${HANDSHAKE_VERSION}`);
  }
  if (Date.now() > offer.expiresAt) {
    throw new Error(`offer expired at ${new Date(offer.expiresAt).toISOString()}`);
  }
  return offer;
}

export async function getPairedDaemon(): Promise<PairedDaemon | null> {
  const raw = await SecureStore.getItemAsync(PAIRED_STORE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PairedDaemon;
  } catch {
    return null;
  }
}

async function setPairedDaemon(d: PairedDaemon): Promise<void> {
  await SecureStore.setItemAsync(PAIRED_STORE_KEY, JSON.stringify(d));
}

export async function clearPairedDaemon(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRED_STORE_KEY);
}

interface PendingRequest {
  resolve: (frame: unknown) => void;
  reject: (err: Error) => void;
}

/** Minimal connected/authenticated daemon WS client. One per session. */
export class DaemonClient {
  private constructor(
    private readonly ws: WebSocket,
    private readonly pending: Map<string, PendingRequest>,
  ) {}

  /**
   * First-time pair via a QR offer. Persists `PairedDaemon` for next launch.
   * Throws on handshake failure.
   */
  static async pair(
    identity: ClientIdentity,
    offer: PairOffer,
  ): Promise<DaemonClient> {
    const sessionId = Crypto.randomUUID();
    const clientNonce = randomBase64UrlBytes(32);
    const hello = {
      type: "client.hello" as const,
      v: HANDSHAKE_VERSION,
      sessionId,
      mode: "qr_bootstrap" as HandshakeMode,
      clientFingerprint: identity.fingerprint,
      clientIdentityPublicKey: identity.publicKeyB64,
      clientNonce,
      offerExpiresAt: offer.expiresAt,
      offerDaemonFingerprint: offer.daemonFingerprint,
    };
    const client = await runHandshake(offer.daemonAddress, identity, hello);
    await setPairedDaemon({
      address: offer.daemonAddress,
      fingerprint: offer.daemonFingerprint,
      identityPublicKey: offer.daemonIdentityPublicKey,
    });
    return client;
  }

  /** Reconnect using a previously-paired daemon. */
  static async reconnect(
    identity: ClientIdentity,
    daemon: PairedDaemon,
  ): Promise<DaemonClient> {
    const sessionId = Crypto.randomUUID();
    const clientNonce = randomBase64UrlBytes(32);
    const hello = {
      type: "client.hello" as const,
      v: HANDSHAKE_VERSION,
      sessionId,
      mode: "trusted_reconnect" as HandshakeMode,
      clientFingerprint: identity.fingerprint,
      clientIdentityPublicKey: identity.publicKeyB64,
      clientNonce,
    };
    return runHandshake(daemon.address, identity, hello);
  }

  /**
   * Send `listSessions` and await the matching response (or `error` frame).
   * Pass `dir` to filter to one project; omit for all projects (iOS groups
   * client-side). V0 surface — extend with sendPrompt / approve / etc. in W3.
   */
  async listSessions(dir?: string): Promise<unknown[]> {
    const requestId = Crypto.randomUUID();
    const frame: { type: string; requestId: string } & Record<string, unknown> =
      { type: "listSessions", requestId };
    if (dir !== undefined) frame.dir = dir;
    const res = (await this.request(frame)) as { sessions: unknown[] };
    return res.sessions;
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  private request(
    frame: { type: string; requestId: string } & Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(frame.requestId, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(frame));
      } catch (err) {
        this.pending.delete(frame.requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Internal: install message routing once handshake completes. */
  static install(
    ws: WebSocket,
    pending: Map<string, PendingRequest>,
  ): DaemonClient {
    const client = new DaemonClient(ws, pending);
    ws.onmessage = (ev) => {
      let frame: { type: string; requestId?: string; message?: string };
      try {
        frame =
          typeof ev.data === "string"
            ? JSON.parse(ev.data)
            : JSON.parse(String(ev.data));
      } catch {
        return; // ignore non-JSON
      }
      if (!frame.requestId) return; // unsolicited / event — V0 unused
      const slot = pending.get(frame.requestId);
      if (!slot) return;
      pending.delete(frame.requestId);
      if (frame.type === "error") {
        slot.reject(new Error(frame.message ?? "daemon error"));
      } else {
        slot.resolve(frame);
      }
    };
    ws.onclose = () => {
      const err = new Error("daemon connection closed");
      for (const [, slot] of pending) slot.reject(err);
      pending.clear();
    };
    return client;
  }
}

// ─── handshake plumbing ───────────────────────────────────────────────────

interface HelloFrame {
  type: "client.hello";
  v: number;
  sessionId: string;
  mode: HandshakeMode;
  clientFingerprint: string;
  clientIdentityPublicKey: string;
  clientNonce: string;
  offerExpiresAt?: number;
  offerDaemonFingerprint?: string;
}

interface ServerHelloFrame {
  type: "server.hello";
  v: number;
  sessionId: string;
  mode: HandshakeMode;
  daemonFingerprint: string;
  daemonIdentityPublicKey: string;
  serverNonce: string;
  clientNonce: string;
  keyEpoch: number;
  expiresAt: number;
  daemonSignature: string;
}

async function runHandshake(
  url: string,
  identity: ClientIdentity,
  hello: HelloFrame,
): Promise<DaemonClient> {
  const ws = new WebSocket(url);
  await waitOpen(ws);

  // Awaiting first message before we install onmessage; ws-server's first
  // emission after our hello is server.hello.
  const serverHelloP = waitFrame<ServerHelloFrame>(ws);
  ws.send(JSON.stringify(hello));
  const serverHello = await serverHelloP;

  if (serverHello.type !== "server.hello") {
    throw new Error(`expected server.hello, got ${serverHello.type}`);
  }
  if (serverHello.clientNonce !== hello.clientNonce) {
    throw new Error("server.hello did not echo our clientNonce — possible MITM");
  }

  const transcriptInput: TranscriptInput = {
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

  const signature = await identity.sign(buildClientAuthTranscript(transcriptInput));
  const readyP = waitFrame<{ type: string }>(ws);
  ws.send(
    JSON.stringify({
      type: "client.auth",
      v: HANDSHAKE_VERSION,
      sessionId: hello.sessionId,
      clientFingerprint: identity.fingerprint,
      keyEpoch: serverHello.keyEpoch,
      clientSignature: signature,
    }),
  );
  const ready = await readyP;
  if (ready.type !== "server.ready") {
    throw new Error(`handshake failed; received ${JSON.stringify(ready)}`);
  }

  const pending = new Map<string, PendingRequest>();
  return DaemonClient.install(ws, pending);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    ws.onopen = () => resolve();
    ws.onerror = (ev) => reject(new Error(`ws error: ${describeEvent(ev)}`));
  });
}

function waitFrame<T>(ws: WebSocket): Promise<T> {
  return new Promise((resolve, reject) => {
    const onMsg = (ev: { data: unknown }) => {
      ws.onmessage = null;
      try {
        const text =
          typeof ev.data === "string" ? ev.data : String(ev.data);
        resolve(JSON.parse(text) as T);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    ws.onmessage = onMsg as unknown as (ev: MessageEvent) => void;
    ws.onclose = () => reject(new Error("closed before frame"));
    ws.onerror = (ev) => reject(new Error(`ws error: ${describeEvent(ev)}`));
  });
}

function describeEvent(ev: unknown): string {
  if (ev && typeof ev === "object" && "message" in ev) {
    return String((ev as { message: unknown }).message);
  }
  return "unknown";
}

// ─── small utils ──────────────────────────────────────────────────────────

function randomBase64UrlBytes(n: number): string {
  return bytesToBase64Url(Crypto.getRandomBytes(n));
}

// Shared-connection orchestration lives in `daemon-client-context.tsx` —
// this module exports primitives (DaemonClient class + pair / reconnect /
// store helpers); the Context owns the single live connection.
