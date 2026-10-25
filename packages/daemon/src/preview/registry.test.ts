import type { PreviewEntry } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import { PreviewRegistry } from "./registry.ts";
import type { ShellApi, ShellInfo } from "./shells.ts";

const DIR = "/proj";

/** opencode's shells in memory; `listen` makes a pid's tree open ports. */
function fakeShells() {
  const shells = new Map<string, ShellInfo>();
  const output = new Map<string, string>();
  const ports = new Map<number, number[]>();
  let next = 1;
  const api: ShellApi = {
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
      return info;
    },
    async get(_directory, id) {
      return shells.get(id) ?? null;
    },
    async list() {
      return [...shells.values()].filter((s) => s.status === "running");
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
    },
  };
  return {
    api,
    shells,
    output,
    ports,
    created: () => next - 1,
    exit(id: string, code: number) {
      const s = shells.get(id) as ShellInfo;
      s.status = "exited";
      s.exit = code;
      if (s.pid) ports.delete(s.pid);
    },
  };
}

function registry(
  shells: ReturnType<typeof fakeShells>,
  listenOnCreate: number[] | null = [5180],
) {
  return new PreviewRegistry({
    shells: {
      ...shells.api,
      async create(directory, input) {
        const info = await shells.api.create(directory, input);
        if (listenOnCreate && info.pid)
          shells.ports.set(info.pid, listenOnCreate);
        return info;
      },
    },
    ports: async (pid) => shells.ports.get(pid) ?? [],
    probe: async (port) => port === 5180 || port === 3001 || port === 8080,
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    waitMs: 40,
    backgroundMs: 200,
    pollMs: 1,
  });
}

describe("PreviewRegistry.start", () => {
  it("returns the URL once a port listens and registers without opening", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const out = await r.start(
      DIR,
      { name: "web", command: "bun run dev", cwd: "web" },
      "ses_a",
    );
    expect(out.isError).toBeFalsy();
    expect(out.text).toBe(
      '"web" is running at http://localhost:5180. Registered (not opened).',
    );
    const [entry] = await r.entries(DIR);
    expect(entry).toMatchObject({
      name: "web",
      status: "running",
      primaryPort: 5180,
    });
    expect(entry?.opened).toBeUndefined();
    expect(shells.shells.get("sh_1")?.cwd).toBe("/proj/web");
    expect(shells.shells.get("sh_1")?.metadata).toEqual({
      thinkite: { preview: "web", open: false, session: "ses_a" },
    });
  });

  it("is idempotent: the same name and command reuse the server, and open just stamps it", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    const again = await r.start(
      DIR,
      { name: "web", command: "bun run dev", open: true },
      "ses_b",
    );
    expect(shells.created()).toBe(1);
    expect(again.text).toBe(
      '"web" is already running at http://localhost:5180. Sent to the user\'s preview pane.',
    );
    const [entry] = await r.entries(DIR);
    expect(entry?.sessions).toEqual(["ses_a", "ses_b"]);
    expect(entry?.opened?.sessionID).toBe("ses_b");

    // Every request is a new stamp, so a device that handled the first one
    // still opens the second.
    const first = entry?.opened?.at ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 2));
    await r.start(DIR, { name: "web", open: true }, "ses_a");
    const [later] = await r.entries(DIR);
    expect(later?.opened?.sessionID).toBe("ses_a");
    expect(later?.opened?.at).toBeGreaterThan(first);
  });

  it("refuses a different command for a running name instead of killing it", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" });
    const out = await r.start(DIR, {
      name: "web",
      command: "vite --port 5181",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("call preview_stop first");
    expect(shells.created()).toBe(1);
  });

  it("starts a new shell when the old one exited", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" });
    shells.exit("sh_1", 1);
    const out = await r.start(DIR, { name: "web", command: "bun run dev" });
    expect(out.isError).toBeFalsy();
    expect(shells.created()).toBe(2);
  });

  it("reports an exit before listening with the last output", async () => {
    const shells = fakeShells();
    const r = new PreviewRegistry({
      shells: {
        ...shells.api,
        async create(directory, input) {
          const info = await shells.api.create(directory, input);
          shells.output.set(
            info.id,
            "\u001b[31merror\u001b[0m when starting dev server:\nError: Port 5180 is already in use\n",
          );
          shells.exit(info.id, 1);
          return info;
        },
      },
      ports: async () => [],
      probe: async () => false,
      sleep: () => new Promise((r) => setTimeout(r, 1)),
      waitMs: 40,
    });
    const out = await r.start(DIR, { name: "web", command: "bun run dev" });
    expect(out.isError).toBe(true);
    expect(out.text).toBe(
      '"web" exited (code 1) before listening on a port.\nLast output:\nerror when starting dev server:\nError: Port 5180 is already in use',
    );
    expect((await r.entries(DIR))[0]).toMatchObject({
      status: "exited",
      exit: 1,
    });
  });

  it("keeps detecting in the background after giving up, and pushes the port", async () => {
    const shells = fakeShells();
    const r = registry(shells, null);
    const pushes: PreviewEntry[][] = [];
    r.subscribe(DIR, (entries) => pushes.push(entries));
    const out = await r.start(DIR, {
      name: "api",
      command: "bun --hot server.ts",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("no port is listening after 0 s");
    shells.ports.set(1001, [8080]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushes.at(-1)?.[0]).toMatchObject({
      status: "running",
      ports: [8080],
      primaryPort: 8080,
    });
  });

  it("needs a command for a new name, but not to reopen a running one", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    expect(await r.start(DIR, { name: "web" })).toEqual({
      text: "command is required to start a server.",
      isError: true,
    });
    await r.start(DIR, { name: "web", command: "bun run dev" });
    const reopen = await r.start(DIR, { name: "web", open: true });
    expect(reopen.isError).toBeFalsy();
    expect(shells.created()).toBe(1);
  });
});

describe("PreviewRegistry.list / stop", () => {
  it("lists the caller's servers by default and counts the rest", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(
      DIR,
      { name: "web", command: "bun run dev", open: true },
      "ses_a",
    );
    await r.start(DIR, { name: "site", command: "next dev" }, "ses_b");
    const mine = await r.list(DIR, "ses_a");
    expect(mine.text).toBe(
      "web: http://localhost:5180 — running, shown to the user — `bun run dev`\n1 more in this project (pass all: true).",
    );
    expect((await r.list(DIR, "ses_a", true)).text.split("\n")).toHaveLength(2);
  });

  it("shows a dead server as exited, not running", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    shells.exit("sh_1", 137);
    expect((await r.list(DIR, "ses_a")).text).toBe(
      "web: exited (code 137) — `bun run dev`",
    );
  });

  it("stops the shell, keeps the entry as killed and names the other sessions", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_b");
    const out = await r.stop(DIR, "web", "ses_a");
    expect(out.text).toBe(
      'Stopped "web". It was also in use by 1 other session(s); it stopped for them too.',
    );
    expect(shells.shells.get("sh_1")?.status).toBe("killed");
    expect((await r.entries(DIR))[0]?.status).toBe("killed");
    expect(await r.stop(DIR, "web")).toEqual({
      text: '"web" is not running (killed).',
    });
    expect((await r.stop(DIR, "nope")).isError).toBe(true);
    const again = await r.start(DIR, { name: "web", command: "bun run dev" });
    expect(again.isError).toBeFalsy();
    expect(shells.created()).toBe(2);
  });
});

describe("PreviewRegistry rebuild and events", () => {
  it("rebuilds entries from shell metadata after a restart", async () => {
    const shells = fakeShells();
    const before = registry(shells);
    await before.start(
      DIR,
      { name: "web", command: "bun run dev", open: true },
      "ses_a",
    );
    await shells.api.create(DIR, {
      command: "echo unrelated; sleep 99",
      metadata: { sessionID: "ses_x" },
    });

    const after = registry(shells);
    await after.rebuild(DIR);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const entries = await after.entries(DIR);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "web",
      status: "running",
      opened: {
        at: shells.shells.get("sh_1")?.time.started,
        sessionID: "ses_a",
      },
      sessions: ["ses_a"],
      primaryPort: 5180,
      command: "bun run dev",
    });
  });

  it("drops the shells a rebuild no longer finds", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" });
    shells.exit("sh_1", 0);
    await r.rebuild(DIR);
    expect((await r.entries(DIR))[0]?.status).toBe("exited");
  });

  it("pushes shell.exited to subscribers", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" });
    const pushes: PreviewEntry[][] = [];
    r.subscribe(DIR, (entries) => pushes.push(entries));
    r.shellExited("sh_1", "killed");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.[0]).toMatchObject({ status: "killed", ports: [] });
  });
});
