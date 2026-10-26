// Which TCP ports the servers started through opencode's shell listen on.
// One look covers every server: `ps` for the process tree, one `lsof` for
// every listening socket on the Mac, then each server gets the ports held
// by its shell's pid and descendants. Each command costs about 20 ms and
// the machine-wide `lsof` about 50 ms (measured 10-25,
// docs/preview-tool-v1.md); t3code's port scanner runs the same `lsof`
// every 3 s. The same `ps` gives a server's process tree (`scanTree`),
// for ending what is left of it when opencode unloads its project.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** `lsof` can hang on a stuck network volume; a scan that times out is
 *  dropped, not read as "nothing listens". */
const TIMEOUT_MS = 5_000;

/** Listening ports per root pid (ascending), or null when a command failed:
 *  callers keep what they knew. */
export type PortScan = (
  roots: number[],
) => Promise<Map<number, number[]> | null>;

async function output(
  cmd: string,
  args: string[],
  /** lsof exits 1 when nothing matched; its stdout is still the answer. */
  exit1IsAnswer = false,
): Promise<string | null> {
  try {
    return (
      await run(cmd, args, {
        maxBuffer: 8 * 1024 * 1024,
        timeout: TIMEOUT_MS,
      })
    ).stdout;
  } catch (err) {
    const e = err as { code?: unknown; killed?: boolean; stdout?: unknown };
    if (
      exit1IsAnswer &&
      !e.killed &&
      e.code === 1 &&
      typeof e.stdout === "string"
    )
      return e.stdout;
    return null;
  }
}

/** pid → its children, from one `ps`. */
function childrenOf(text: string): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const line of text.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  return children;
}

/** pid → listening ports, from `lsof -F pn`: a `p<pid>` line, then an
 *  `n<addr>:<port>` line per socket. */
function portsOf(text: string): Map<number, Set<number>> {
  const byPid = new Map<number, Set<number>>();
  let current: Set<number> | undefined;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) {
      const pid = Number(line.slice(1));
      current = byPid.get(pid) ?? new Set();
      byPid.set(pid, current);
    } else if (line.startsWith("n") && current) {
      const port = Number(line.slice(line.lastIndexOf(":") + 1));
      if (Number.isInteger(port) && port > 0) current.add(port);
    }
  }
  return byPid;
}

/** Each root's tree's listening ports, from `ps -axo pid=,ppid=` and
 *  `lsof -F pn` output. */
export function treePorts(
  psText: string,
  lsofText: string,
  roots: number[],
): Map<number, number[]> {
  const children = childrenOf(psText);
  const listening = portsOf(lsofText);
  const result = new Map<number, number[]>();
  for (const root of roots) {
    const ports = new Set<number>();
    const stack = [root];
    const seen = new Set<number>();
    while (stack.length > 0) {
      const pid = stack.pop() as number;
      if (seen.has(pid)) continue;
      seen.add(pid);
      for (const port of listening.get(pid) ?? []) ports.add(port);
      stack.push(...(children.get(pid) ?? []));
    }
    result.set(
      root,
      [...ports].sort((a, b) => a - b),
    );
  }
  return result;
}

/** Each root's tree (roots first), from `ps -axo pid=,ppid=` output. */
export function treePids(psText: string, roots: number[]): number[] {
  const children = childrenOf(psText);
  const seen = new Set<number>();
  const stack = [...roots].reverse();
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (seen.has(pid)) continue;
    seen.add(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return [...seen];
}

/** The pids in the roots' trees, from one `ps`; null when it failed. */
export async function scanTree(roots: number[]): Promise<number[] | null> {
  if (roots.length === 0) return [];
  const ps = await output("ps", ["-axo", "pid=,ppid="]);
  return ps === null ? null : treePids(ps, roots);
}

/** Each root's tree's listening ports, from one `ps` and one `lsof`. */
export const scanPorts: PortScan = async (roots) => {
  if (roots.length === 0) return new Map();
  const [ps, lsof] = await Promise.all([
    output("ps", ["-axo", "pid=,ppid="]),
    output("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"], true),
  ]);
  if (ps === null || lsof === null) return null;
  return treePorts(ps, lsof, roots);
};
