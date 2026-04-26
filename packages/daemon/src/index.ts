import { PROTOCOL_VERSION } from "@sidecodeapp/protocol";

export interface DaemonOptions {
  port?: number;
  host?: string;
}

export interface Daemon {
  stop(): Promise<void>;
}

export async function start(options: DaemonOptions = {}): Promise<Daemon> {
  const port = options.port ?? 41234;
  const host = options.host ?? "127.0.0.1";

  console.log(
    `sidecode daemon (protocol ${PROTOCOL_VERSION}) listening on ${host}:${port}`,
  );

  // TODO(W1): ed25519 identity load/create, mDNS register, WS server, Agent SDK wrapper.
  return {
    async stop() {
      console.log("sidecode daemon stopped");
    },
  };
}
