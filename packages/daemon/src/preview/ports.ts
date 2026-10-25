// Which TCP ports a server started through opencode's shell listens on:
// the shell's pid, its descendants from `ps`, then `lsof` scoped to those
// pids. Measured on 10-24 (docs/preview-tool-v1.md): Vite, Next.js and
// `bun --hot` show up 0.1–1.4 s after the shell starts, and each of `ps`
// and per-pid `lsof` costs about 20 ms.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

async function output(cmd: string, args: string[]): Promise<string> {
  try {
    return (await run(cmd, args, { maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch (err) {
    // lsof exits 1 when nothing matched; its stdout is still the answer.
    const stdout = (err as { stdout?: unknown }).stdout;
    return typeof stdout === "string" ? stdout : "";
  }
}

/** `root` and every process below it. */
export async function descendants(root: number): Promise<number[]> {
  const children = new Map<number, number[]>();
  for (const line of (await output("ps", ["-axo", "pid=,ppid="])).split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    out.push(pid);
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

/** Listening TCP ports of `root`'s process tree, ascending. */
export async function listeningPorts(root: number): Promise<number[]> {
  const pids = await descendants(root);
  const text = await output("lsof", [
    "-a",
    "-p",
    pids.join(","),
    "-nP",
    "-iTCP",
    "-sTCP:LISTEN",
    "-Fn",
  ]);
  const ports = new Set<number>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("n")) continue;
    const port = Number(line.slice(line.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}
