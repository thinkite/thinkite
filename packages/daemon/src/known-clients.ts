import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A paired iOS / mobile client. Acts like an SSH known_hosts entry. */
export interface KnownClient {
  fingerprint: string; // 16 hex chars, derived from publicKeyB64
  publicKeyB64: string; // base64url ed25519 raw pubkey
  pairedAt: number; // epoch ms
  label?: string; // human-readable label (V1 will let users edit)
}

const FILE_NAME = "known_clients.json";

interface FileShape {
  v: 1;
  clients: KnownClient[];
}

export class KnownClients {
  private constructor(
    private readonly path: string,
    private readonly clients: KnownClient[],
  ) {}

  static load(home: string): KnownClients {
    const path = join(home, FILE_NAME);
    if (!existsSync(path)) return new KnownClients(path, []);
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as FileShape;
    if (parsed.v !== 1) {
      throw new Error(`unsupported known_clients.json version: ${parsed.v}`);
    }
    return new KnownClients(path, parsed.clients);
  }

  has(fingerprint: string): boolean {
    return this.clients.some((c) => c.fingerprint === fingerprint);
  }

  list(): readonly KnownClient[] {
    return this.clients;
  }

  /** Add a client and persist. Throws if fingerprint already known. */
  add(client: KnownClient): void {
    if (this.has(client.fingerprint)) {
      throw new Error(`already paired: ${client.fingerprint}`);
    }
    this.clients.push(client);
    this.persist();
  }

  private persist(): void {
    const payload: FileShape = { v: 1, clients: this.clients };
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmp, this.path);
  }
}
