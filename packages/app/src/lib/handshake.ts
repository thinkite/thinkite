import { base64UrlToBytes } from "./base64";

/**
 * Mirror of @sidecodeapp/protocol's transcript builder. Re-implemented here
 * (no workspace import) so Metro doesn't have to resolve a TS workspace
 * package. Keep these constants and field order in lockstep with the daemon
 * — divergence breaks the handshake silently with `invalid_signature`.
 *
 * Source of truth: packages/protocol/src/index.ts
 */

export const HANDSHAKE_VERSION = 1;
export const HANDSHAKE_DOMAIN_TAG = "sidecode-handshake-v1";
export const CLIENT_AUTH_LABEL = "client-auth";

export type HandshakeMode = "qr_bootstrap" | "trusted_reconnect";

export interface TranscriptInput {
  sessionId: string;
  protocolVersion: number;
  mode: HandshakeMode;
  keyEpoch: number;
  daemonFingerprint: string;
  clientFingerprint: string;
  daemonIdentityPublicKey: string; // base64url
  clientIdentityPublicKey: string; // base64url
  clientNonce: string; // base64url
  serverNonce: string; // base64url
  expiresAt: number;
}

/**
 * Build the transcript bytes for the handshake signature. Length-prefixed
 * concat (u32 BE + payload) prevents field-boundary ambiguity. base64url
 * fields are decoded so the same bytes are reachable from any platform.
 *
 * Daemon signs `buildTranscript(...)` directly.
 * Client signs `buildTranscript(...) || CLIENT_AUTH_LABEL` (UTF-8 bytes).
 */
export function buildTranscript(input: TranscriptInput): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(prefix(textBytes(HANDSHAKE_DOMAIN_TAG)));
  parts.push(prefix(textBytes(input.sessionId)));
  parts.push(prefix(textBytes(String(input.protocolVersion))));
  parts.push(prefix(textBytes(input.mode)));
  parts.push(prefix(textBytes(String(input.keyEpoch))));
  parts.push(prefix(textBytes(input.daemonFingerprint)));
  parts.push(prefix(textBytes(input.clientFingerprint)));
  parts.push(prefix(base64UrlToBytes(input.daemonIdentityPublicKey)));
  parts.push(prefix(base64UrlToBytes(input.clientIdentityPublicKey)));
  parts.push(prefix(base64UrlToBytes(input.clientNonce)));
  parts.push(prefix(base64UrlToBytes(input.serverNonce)));
  parts.push(prefix(textBytes(String(input.expiresAt))));
  return concat(parts);
}

export function buildClientAuthTranscript(input: TranscriptInput): Uint8Array {
  const base = buildTranscript(input);
  const label = textBytes(CLIENT_AUTH_LABEL);
  return concat([base, label]);
}

function textBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function prefix(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + bytes.length);
  out[0] = (bytes.length >>> 24) & 0xff;
  out[1] = (bytes.length >>> 16) & 0xff;
  out[2] = (bytes.length >>> 8) & 0xff;
  out[3] = bytes.length & 0xff;
  out.set(bytes, 4);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
