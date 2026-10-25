// The slice of opencode's shell API the preview registry uses, behind an
// interface so tests can fake it. The shells are the ones the agent's own
// `shell` tool starts in the background (`/api/shell`); `remove` kills the
// whole process tree.

import { OpenCode } from "@opencode/client";
import type { OpencodeConnection } from "../opencode/registry.ts";
import type { ResolveOpencode } from "../opencode/service.ts";

export type ShellStatus = "running" | "exited" | "timeout" | "killed";

export interface ShellInfo {
  id: string;
  status: ShellStatus;
  command: string;
  cwd: string;
  pid?: number;
  exit?: number;
  metadata: Record<string, unknown>;
  time: { started: number; completed?: number };
}

export interface ShellApi {
  /** Exited shells too: opencode keeps them for a while. */
  get(directory: string, id: string): Promise<ShellInfo | null>;
  remove(directory: string, id: string): Promise<void>;
}

export function authorization(conn: OpencodeConnection): string {
  return `Basic ${Buffer.from(`${conn.username}:${conn.password}`).toString("base64")}`;
}

export type OpencodeClient = ReturnType<typeof OpenCode.make>;

export function opencodeClient(conn: OpencodeConnection): OpencodeClient {
  return OpenCode.make({
    baseUrl: conn.baseUrl,
    headers: { authorization: authorization(conn) },
  });
}

/** ShellApi on the user's opencode service, resolved per call. */
export function createShellApi(resolve: ResolveOpencode): ShellApi {
  const client = async () => opencodeClient(await resolve());
  const at = (directory: string) => ({ location: { directory } });
  return {
    async get(directory, id) {
      try {
        return (await (await client()).shell.get({ ...at(directory), id }))
          .data as ShellInfo;
      } catch {
        return null;
      }
    },
    async remove(directory, id) {
      await (await client()).shell.remove({ ...at(directory), id });
    },
  };
}
