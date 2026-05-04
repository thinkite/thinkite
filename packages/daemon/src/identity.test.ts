import {
  sign as cryptoSign,
  verify as cryptoVerify,
  generateKeyPairSync,
} from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadOrCreateIdentity, publicKeyFromB64 } from "./identity.js";

describe("loadOrCreateIdentity", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-identity-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates identity on first call", () => {
    const id = loadOrCreateIdentity(home);
    expect(id.publicKeyB64).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    expect(id.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(id.privateKey).toBeDefined();
  });

  it("persists identity to file with 0600 permissions", () => {
    loadOrCreateIdentity(home);
    const stat = statSync(join(home, "identity.ed25519"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("returns the same identity on second call (load, not regenerate)", () => {
    const a = loadOrCreateIdentity(home);
    const b = loadOrCreateIdentity(home);
    expect(b.publicKeyB64).toBe(a.publicKeyB64);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it("private key can sign and matching pubkey verifies", () => {
    const id = loadOrCreateIdentity(home);
    const message = Buffer.from("hello sidecode");
    const signature = cryptoSign(null, message, id.privateKey);
    const verifyKey = publicKeyFromB64(id.publicKeyB64);
    expect(cryptoVerify(null, message, verifyKey, signature)).toBe(true);
  });

  it("mismatched key rejects verify", () => {
    const id = loadOrCreateIdentity(home);
    const { publicKey: otherPub } = generateKeyPairSync("ed25519");
    const message = Buffer.from("hello");
    const signature = cryptoSign(null, message, id.privateKey);
    expect(cryptoVerify(null, message, otherPub, signature)).toBe(false);
  });
});

describe("publicKeyFromB64", () => {
  it("decodes a 32-byte ed25519 pubkey", () => {
    const home = mkdtempSync(join(tmpdir(), "sidecode-id-decode-"));
    try {
      const id = loadOrCreateIdentity(home);
      const decoded = publicKeyFromB64(id.publicKeyB64);
      expect(decoded.asymmetricKeyType).toBe("ed25519");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("rejects a wrong-length pubkey", () => {
    expect(() => publicKeyFromB64("AAAA")).toThrow(/32-byte/);
  });
});
