import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForwardPort, PreviewEntry } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import { PreviewRegistry } from "./registry.ts";
import type { ShellApi, ShellInfo } from "./shells.ts";

const DIR = "/proj";

/** opencode's shells in memory. A created shell's process tree listens on
 *  `listen(command)` and prints `print(command)`; `onRemove` runs inside
 *  `remove`, where opencode publishes `shell.exited`. */
function fakeShells(
  listen: (command: string) => number[] = () => [5173],
  print: (command: string) => string = () =>
    "  ➜  Local:   http://localhost:5173/\n",
) {
  const shells = new Map<string, ShellInfo>();
  const output = new Map<string, string>();
  const ports = new Map<number, number[]>();
  const created: ShellInfo[] = [];
  let next = 1;
  const fake = {
    onRemove: undefined as ((id: string) => void) | undefined,
    api: {
      async create(_directory, input) {
        const id = `sh_${next}`;
        const info: ShellInfo = {
          id,
          status: "running",
          command: input.command,
          cwd: input.cwd ?? DIR,
          pid: 1000 + next,
          metadata: input.metadata,
          time: { started: 1 },
        };
        next += 1;
        shells.set(id, info);
        created.push(info);
        ports.set(info.pid as number, listen(input.command));
        output.set(id, print(input.command));
        return info;
      },
      async get(_directory, id) {
        return shells.get(id) ?? null;
      },
      async tail(_directory, id) {
        return output.get(id) ?? "";
      },
      async remove(_directory, id) {
        const s = shells.get(id);
        if (s) {
          s.status = "killed";
          if (s.pid) ports.delete(s.pid);
        }
        fake.onRemove?.(id);
      },
    } as ShellApi,
    ports,
    output,
    created,
    exit(id: string, code: number) {
      const s = shells.get(id) as ShellInfo;
      s.status = "exited";
      s.exit = code;
      if (s.pid) ports.delete(s.pid);
    },
    kill(id: string) {
      const s = shells.get(id) as ShellInfo;
      s.status = "killed";
      if (s.pid) ports.delete(s.pid);
    },
  };
  return fake;
}

function registry(
  shells: ReturnType<typeof fakeShells>,
  options: { stateFile?: string; scheduled?: (() => void)[] } = {},
) {
  return new PreviewRegistry({
    shells: shells.api,
    ports: async (pid) => shells.ports.get(pid) ?? [],
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    schedule: (fn) => options.scheduled?.push(fn),
    startWaitMs: 500,
    ...(options.stateFile === undefined
      ? {}
      : { stateFile: options.stateFile }),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 2));

describe("PreviewRegistry.start / logs", () => {
  it("starts a shell of its own and hands back the first output", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const out = await r.start(
      DIR,
      { name: "web", command: "bun run dev", cwd: "web" },
      "ses_a",
    );
    expect(out).toEqual({
      text: `Started "web", listening on http://localhost:5173/. Output so far:\n  ➜  Local:   http://localhost:5173/`,
    });
    expect(shells.created[0]).toMatchObject({
      cwd: "/proj/web",
      metadata: { thinkite: { server: "web", session: "ses_a" } },
    });
    const [entry] = (await r.snapshot(DIR)).entries;
    expect(entry).toEqual({
      name: "web",
      ports: [5173],
      url: "http://localhost:5173/",
      status: "running",
      command: "bun run dev",
      started: { at: 1, sessionID: "ses_a" },
    } satisfies PreviewEntry);
  });

  it("is idempotent per name across sessions, and never restarts implicitly", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    const again = await r.start(DIR, { name: "web" }, "ses_b");
    expect(again.text).toContain(
      `"web" is already running, http://localhost:5173/. Recent output:`,
    );
    expect(shells.created).toHaveLength(1);
    expect(
      await r.start(DIR, { name: "web", command: "vite --port 6000" }),
    ).toEqual({
      text: '"web" is already running `bun run dev`; stop it first to change it.',
      isError: true,
    });
    expect(await r.start(DIR, { name: "api" })).toEqual({
      text: "command is required to start a server.",
      isError: true,
    });
  });

  it("reports a server that ends right away, with its output", async () => {
    const shells = fakeShells(
      () => [],
      () => "error: Failed to start server. Is port 8790 in use?\n",
    );
    const r = new PreviewRegistry({
      shells: {
        ...shells.api,
        async create(directory, input) {
          const info = await shells.api.create(directory, input);
          shells.exit(info.id, 1);
          return { ...info, status: "running" };
        },
      },
      ports: async () => [],
      sleep: async () => undefined,
      schedule: () => undefined,
      startWaitMs: 500,
    });
    expect(
      await r.start(DIR, { name: "api", command: "bun server.ts" }),
    ).toEqual({
      text: `"api" exited right away (code 1). Output:\nerror: Failed to start server. Is port 8790 in use?`,
      isError: true,
    });
    expect((await r.snapshot(DIR)).entries[0]).toMatchObject({
      status: "ended",
      ended: { by: "process", exit: 1 },
    });
  });

  it("restarts a name that ended, and tells the agent how it ended", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    await r.stop(DIR, "web", { by: "user" });
    const out = await r.start(
      DIR,
      { name: "web", command: "bun run dev" },
      "ses_b",
    );
    expect(out.text).toMatch(
      /\nNote: the previous "web" was stopped by the user just now\.$/,
    );
    expect(shells.created).toHaveLength(2);
    const [entry] = (await r.snapshot(DIR)).entries;
    expect(entry).toMatchObject({
      status: "running",
      started: { sessionID: "ses_b" },
    });
    expect(entry?.ended).toBeUndefined();
  });

  it("shows the latest output with how the server stands", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "next dev" });
    shells.output.set("sh_1", "▲ Next.js\n✓ Ready in 1.2s\n");
    expect((await r.logs(DIR, "web")).text).toBe(
      `"web" is running, http://localhost:5173/.\n▲ Next.js\n✓ Ready in 1.2s`,
    );
    shells.exit("sh_1", 1);
    expect((await r.logs(DIR, "web")).text).toMatch(
      /^"web" exited \(code 1\) just now\./,
    );
    expect((await r.logs(DIR, "nope")).isError).toBe(true);
  });
});

describe("PreviewRegistry ports and URL", () => {
  it("takes the URL from the lowest port the server listens on", async () => {
    const shells = fakeShells(() => [24678, 5173].sort((a, b) => a - b));
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "vite" });
    expect((await r.snapshot(DIR)).entries[0]).toMatchObject({
      ports: [5173, 24678],
      url: "http://localhost:5173/",
    });
  });

  it("finds a port that opens after the start, and pushes it", async () => {
    const shells = fakeShells(() => []);
    const scheduled: (() => void)[] = [];
    const r = registry(shells, { scheduled });
    const out = await r.start(DIR, { name: "web", command: "next dev" });
    expect(out.text).toMatch(/^Started "web"\. Output so far:/);
    expect((await r.snapshot(DIR)).entries[0]?.url).toBeUndefined();
    const pushed: PreviewEntry[][] = [];
    r.subscribe(DIR, (s) => pushed.push(s.entries));
    shells.ports.set(1001, [3000]);
    scheduled[0]?.();
    await tick();
    expect(pushed.at(-1)?.[0]?.url).toBe("http://localhost:3000/");
    expect((await r.logs(DIR, "web")).text).toMatch(
      /^"web" is running, http:\/\/localhost:3000\/\./,
    );
  });

  it("keeps the ports of a server that ended, and leaves the URL out of its state", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "vite" });
    await r.stop(DIR, "web", { by: "user" });
    expect((await r.snapshot(DIR)).entries[0]).toMatchObject({
      status: "ended",
      ports: [5173],
    });
    expect((await r.list(DIR)).text).toBe(
      "web: was stopped by the user just now — `vite`",
    );
  });
});

describe("PreviewRegistry.list / stop", () => {
  it("lists the whole project and marks the caller's own", async () => {
    const shells = fakeShells((c) => (c === "bun api.ts" ? [8787] : [5173]));
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    await r.start(DIR, { name: "api", command: "bun api.ts" }, "ses_b");
    await r.start(DIR, { name: "docs", command: "bun run docs" }, "ses_b");
    await r.stop(DIR, "docs", { by: "user" });
    expect((await r.list(DIR, "ses_a")).text).toBe(
      "web: is running, http://localhost:5173/ — `bun run dev` (yours)\n" +
        "api: is running, http://localhost:8787/ — `bun api.ts`\n" +
        "docs: was stopped by the user just now — `bun run docs`",
    );
    expect((await r.list("/empty", "ses_a")).text).toBe(
      "No servers in this project.",
    );
  });

  it("records who stopped a server, even when the exit event comes first", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    shells.onRemove = (id) => r.shellExited(id, "killed");
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    expect(
      (await r.stop(DIR, "web", { by: "agent", sessionID: "ses_a" })).text,
    ).toBe(`Stopped "web".`);
    expect((await r.snapshot(DIR)).entries[0]?.ended).toEqual({
      at: expect.any(Number),
      by: "agent",
      sessionID: "ses_a",
    });
    expect((await r.stop(DIR, "web", { by: "user" })).text).toBe(
      `"web" is not running: it was stopped by another session just now.`,
    );
    expect((await r.stop(DIR, "nope", { by: "user" })).isError).toBe(true);
  });

  it("warns an agent that stops another session's server", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    expect(
      (await r.stop(DIR, "web", { by: "agent", sessionID: "ses_b" })).text,
    ).toBe(`Stopped "web". Another session started it; it stopped there too.`);
  });

  it("tells a process exit from a kill outside Thinkite", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "vite" });
    await r.start(DIR, { name: "api", command: "bun api.ts" });
    const pushed: PreviewEntry[][] = [];
    r.subscribe(DIR, (s) => pushed.push(s.entries));
    shells.exit("sh_1", 2);
    r.shellExited("sh_1", "exited", 2);
    shells.kill("sh_2");
    expect((await r.snapshot(DIR)).entries.map((e) => e.ended?.by)).toEqual([
      "process",
      "external",
    ]);
    expect(pushed[0]?.[0]?.ended).toMatchObject({ by: "process", exit: 2 });
  });
});

describe("PreviewRegistry forward ports", () => {
  it("lists every running server's ports across projects, and pushes changes", async () => {
    const shells = fakeShells((c) =>
      c === "bun api.ts" ? [8787] : c === "vite" ? [5173, 24678] : [],
    );
    const scheduled: (() => void)[] = [];
    const r = registry(shells, { scheduled });
    const pushed: ForwardPort[][] = [];
    r.subscribePorts((p) => pushed.push(p));
    await r.start(DIR, { name: "web", command: "vite" });
    await r.start("/other", { name: "api", command: "bun api.ts" });
    expect(scheduled).toHaveLength(8); // four checks after each start
    expect(await r.forwardPorts()).toEqual([
      { port: 5173, directory: DIR, name: "web" },
      { port: 8787, directory: "/other", name: "api" },
      { port: 24678, directory: DIR, name: "web" },
    ]);
    expect(pushed).toHaveLength(2); // once per start, as each one listens
    await r.stop(DIR, "web", { by: "user" });
    await tick();
    expect(pushed.at(-1)).toEqual([
      { port: 8787, directory: "/other", name: "api" },
    ]);
  });
});

describe("PreviewRegistry persistence", () => {
  it("brings running entries back after a restart and re-checks them", async () => {
    const stateFile = join(
      mkdtempSync(join(tmpdir(), "previews-")),
      "previews.json",
    );
    const shells = fakeShells();
    const before = registry(shells, { stateFile });
    await before.start(DIR, { name: "web", command: "vite" }, "ses_a");
    await before.start(DIR, { name: "api", command: "bun api.ts" }, "ses_a");
    await before.start(DIR, { name: "old", command: "bun old.ts" });
    await before.stop(DIR, "old", { by: "user" });
    const saved = JSON.parse(readFileSync(stateFile, "utf8"));
    expect(saved.v).toBe(2);
    expect(saved.entries).toHaveLength(3);

    shells.exit("sh_2", 0); // api, while the daemon was down
    const after = registry(shells, { stateFile });
    await after.rebuild(DIR);
    const { entries } = await after.snapshot(DIR);
    expect(entries.map((e) => [e.name, e.status, e.ended?.by])).toEqual([
      ["web", "running", undefined],
      ["api", "ended", "process"],
    ]);
    expect(entries[0]).toMatchObject({ url: "http://localhost:5173/" });
  });
});
