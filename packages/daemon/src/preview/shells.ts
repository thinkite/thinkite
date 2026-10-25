// The slice of opencode's shell API the preview registry uses, behind an
// interface so tests can fake it. A shell created here is the same kind of
// process the agent's own `shell` tool starts in the background: same list,
// same output file, and `remove` kills the whole process tree.

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
  create(
    directory: string,
    input: { command: string; cwd?: string; metadata: Record<string, unknown> },
  ): Promise<ShellInfo>;
  get(directory: string, id: string): Promise<ShellInfo | null>;
  /** Running shells only (opencode keeps exited ones for get/output). */
  list(directory: string): Promise<ShellInfo[]>;
  /** The last `bytes` of the shell's output. */
  tail(directory: string, id: string, bytes: number): Promise<string>;
  remove(directory: string, id: string): Promise<void>;
}

export function authorization(conn: OpencodeConnection): string {
  return `Basic ${Buffer.from(`${conn.username}:${conn.password}`).toString("base64")}`;
}

export type OpencodeClient = ReturnType<typeof OpenCode.make>;
type CreateInput = Parameters<OpencodeClient["shell"]["create"]>[0];

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
    async create(directory, input) {
      const res = await (await client()).shell.create({
        ...at(directory),
        ...input,
        metadata: input.metadata as CreateInput["metadata"],
      });
      return res.data as ShellInfo;
    },
    async get(directory, id) {
      try {
        return (await (await client()).shell.get({ ...at(directory), id }))
          .data as ShellInfo;
      } catch {
        return null;
      }
    },
    async list(directory) {
      return (await (await client()).shell.list(at(directory)))
        .data as ShellInfo[];
    },
    async tail(directory, id, bytes) {
      const c = await client();
      // A cursor past the end answers with the size and no bytes.
      const end = await c.shell.output({
        ...at(directory),
        id,
        cursor: Number.MAX_SAFE_INTEGER,
      });
      const cursor = Math.max(0, end.data.size - bytes);
      return (
        await c.shell.output({ ...at(directory), id, cursor, limit: bytes })
      ).data.output;
    },
    async remove(directory, id) {
      await (await client()).shell.remove({ ...at(directory), id });
    },
  };
}
