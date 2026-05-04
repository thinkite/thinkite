import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnownClients } from "./known-clients.js";

describe("KnownClients", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-kc-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("starts empty when no file exists", () => {
    const kc = KnownClients.load(home);
    expect(kc.list()).toEqual([]);
    expect(kc.has("any")).toBe(false);
  });

  it("adds a client and persists across reloads", () => {
    const kc = KnownClients.load(home);
    kc.add({
      fingerprint: "abc123def456ghi7",
      publicKeyB64: "Zm9vYmFy",
      pairedAt: 1700000000000,
    });
    const reloaded = KnownClients.load(home);
    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.has("abc123def456ghi7")).toBe(true);
  });

  it("persists with 0600 perms", () => {
    const kc = KnownClients.load(home);
    kc.add({
      fingerprint: "x".repeat(16),
      publicKeyB64: "k",
      pairedAt: 1,
    });
    expect(statSync(join(home, "known_clients.json")).mode & 0o777).toBe(0o600);
  });

  it("rejects duplicate fingerprint", () => {
    const kc = KnownClients.load(home);
    kc.add({
      fingerprint: "dup1234567890123",
      publicKeyB64: "k1",
      pairedAt: 1,
    });
    expect(() =>
      kc.add({
        fingerprint: "dup1234567890123",
        publicKeyB64: "k2",
        pairedAt: 2,
      }),
    ).toThrow(/already paired/);
  });

  it("preserves label field across reload", () => {
    const kc = KnownClients.load(home);
    kc.add({
      fingerprint: "labeled1234567ab",
      publicKeyB64: "k",
      pairedAt: 1,
      label: "iPhone of Yueqian",
    });
    const reloaded = KnownClients.load(home);
    expect(reloaded.list()[0]?.label).toBe("iPhone of Yueqian");
  });

  it("throws on unsupported file version", () => {
    writeFileSync(
      join(home, "known_clients.json"),
      JSON.stringify({ v: 99, clients: [] }),
    );
    expect(() => KnownClients.load(home)).toThrow(/unsupported/);
  });
});
