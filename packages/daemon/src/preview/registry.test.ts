import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewEntry } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import { isThisMachine, PreviewRegistry } from "./registry.ts";
import type { ShellApi, ShellInfo } from "./shells.ts";

const DIR = "/proj";

/** opencode's shells in memory. A created shell's process tree listens on
 *  `listen(command)` and prints `print(command)`. */
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
    },
  };
  return {
    api,
    ports,
    output,
    created,
    exit(id: string, code: number) {
      const s = shells.get(id) as ShellInfo;
      s.status = "exited";
      s.exit = code;
      if (s.pid) ports.delete(s.pid);
    },
  };
}

function registry(shells: ReturnType<typeof fakeShells>, stateFile?: string) {
  return new PreviewRegistry({
    shells: shells.api,
    ports: async (pid) => shells.ports.get(pid) ?? [],
    sleep: () => new Promise((r) => setTimeout(r, 1)),
    startWaitMs: 500,
    ...(stateFile === undefined ? {} : { stateFile }),
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
      text: `Started "web". Output so far:\n  ➜  Local:   http://localhost:5173/`,
    });
    expect(shells.created[0]).toMatchObject({
      cwd: "/proj/web",
      metadata: { thinkite: { server: "web", session: "ses_a" } },
    });
    const [entry] = await r.entries(DIR);
    expect(entry).toMatchObject({
      name: "web",
      status: "running",
      command: "bun run dev",
      sessions: ["ses_a"],
    });
    expect(entry?.url).toBeUndefined();
    expect(entry?.opened).toBeUndefined();
  });

  it("is idempotent per name and never restarts implicitly", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    const again = await r.start(DIR, { name: "web" }, "ses_b");
    expect(again.text).toContain(`"web" is already running. Recent output:`);
    expect(shells.created).toHaveLength(1);
    expect((await r.entries(DIR))[0]?.sessions).toEqual(["ses_a", "ses_b"]);
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
      startWaitMs: 500,
    });
    expect(
      await r.start(DIR, { name: "api", command: "bun server.ts" }),
    ).toEqual({
      text: `"api" exited (code 1) right away. Output:\nerror: Failed to start server. Is port 8790 in use?`,
      isError: true,
    });
    expect((await r.entries(DIR))[0]?.status).toBe("exited");
  });

  it("shows the latest output with the state", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "next dev" });
    shells.output.set("sh_1", "▲ Next.js\n✓ Ready in 1.2s\n");
    expect((await r.logs(DIR, "web")).text).toBe(
      `"web" is running.\n▲ Next.js\n✓ Ready in 1.2s`,
    );
    expect((await r.logs(DIR, "nope")).isError).toBe(true);
  });
});

describe("PreviewRegistry.open", () => {
  it("shows a page its server serves", async () => {
    const shells = fakeShells(() => [5173, 24678]);
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    expect(await r.open(DIR, "web", "http://localhost:5173", "ses_a")).toEqual({
      text: "Sent http://localhost:5173/ to the user's browser.",
    });
    expect((await r.entries(DIR))[0]).toMatchObject({
      url: "http://localhost:5173/",
      opened: { sessionID: "ses_a" },
    });
  });

  it("refuses a local URL the server does not listen on, and says where it does", async () => {
    const shells = fakeShells((c) => (c === "vite" ? [5174] : []));
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "vite" });
    expect(await r.open(DIR, "web", "http://localhost:5173/")).toEqual({
      text: `"web" is not listening on 5173 (it listens on 5174). Nothing was opened.`,
      isError: true,
    });
    await r.start(DIR, { name: "next", command: "next dev" });
    const early = await r.open(DIR, "next", "http://localhost:3000/");
    expect(early.isError).toBe(true);
    expect(early.text).toContain("not listening on 3000 yet");
    expect((await r.entries(DIR)).every((e) => e.url === undefined)).toBe(true);
  });

  it("takes a tunnel or public URL as given", async () => {
    const shells = fakeShells(() => []);
    const r = registry(shells);
    await r.start(DIR, {
      name: "tunnel",
      command: "cloudflared tunnel --url http://localhost:5173",
    });
    expect(
      (await r.open(DIR, "tunnel", "https://abc.trycloudflare.com", "ses_a"))
        .isError,
    ).toBeFalsy();
    expect((await r.entries(DIR))[0]?.url).toBe(
      "https://abc.trycloudflare.com/",
    );
  });

  it("needs a running server of that name and an http(s) URL", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    expect((await r.open(DIR, "web", "http://localhost:5173/")).text).toBe(
      `No server named "web". List them, or start it first.`,
    );
    await r.start(DIR, { name: "web", command: "bun run dev" });
    expect(await r.open(DIR, "web", "file:///tmp/a.html")).toEqual({
      text: "The URL must be http or https.",
      isError: true,
    });
    shells.exit("sh_1", 1);
    expect((await r.open(DIR, "web", "http://localhost:5173/")).text).toBe(
      `"web" is not running (exited (code 1)). Check its logs.`,
    );
  });

  it("shows the page again with a new stamp, and adds the session", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    await r.open(DIR, "web", "http://localhost:5173/", "ses_a");
    const first = (await r.entries(DIR))[0]?.opened?.at ?? 0;
    await tick();
    await r.open(DIR, "web", "http://localhost:5173/", "ses_b");
    const [entry] = await r.entries(DIR);
    expect(entry?.opened?.sessionID).toBe("ses_b");
    expect(entry?.opened?.at).toBeGreaterThan(first);
    expect(entry?.sessions).toEqual(["ses_a", "ses_b"]);
  });
});

describe("PreviewRegistry.list / stop", () => {
  it("lists the caller's servers by default and counts the rest", async () => {
    const shells = fakeShells((c) => (c === "bun api.ts" ? [8787] : [5173]));
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    await r.open(DIR, "web", "http://localhost:5173/", "ses_a");
    await r.start(DIR, { name: "api", command: "bun api.ts" }, "ses_b");
    expect((await r.list(DIR, "ses_a")).text).toBe(
      "web: running, http://localhost:5173/ shown to the user — `bun run dev`\n" +
        "1 more in this project (pass all: true).",
    );
    expect((await r.list(DIR, "ses_b")).text.split("\n")[0]).toBe(
      "api: running — `bun api.ts`",
    );
    expect((await r.list(DIR, "ses_a", true)).text.split("\n")).toHaveLength(2);
  });

  it("shows a dead server as exited", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" });
    shells.exit("sh_1", 137);
    expect((await r.list(DIR)).text).toBe(
      "web: exited (code 137) — `bun run dev`",
    );
  });

  it("stops the shell, keeps the entry as killed and names the other sessions", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    await r.start(DIR, { name: "web" }, "ses_b");
    expect((await r.stop(DIR, "web", "ses_a")).text).toBe(
      `Stopped "web". It was also in use by 1 other session(s); it stopped for them too.`,
    );
    expect((await r.entries(DIR))[0]?.status).toBe("killed");
    expect((await r.stop(DIR, "web")).text).toBe(
      `"web" is not running (killed).`,
    );
    expect((await r.stop(DIR, "nope")).isError).toBe(true);
  });

  it("starts a new shell for a name whose server ended", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" });
    await r.stop(DIR, "web");
    await r.start(DIR, { name: "web", command: "bun run dev" });
    expect(shells.created).toHaveLength(2);
    expect((await r.entries(DIR))[0]?.status).toBe("running");
  });

  it("pushes shell.exited to subscribers", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    await r.start(DIR, { name: "web", command: "bun run dev" });
    const pushed: PreviewEntry[][] = [];
    r.subscribe(DIR, (entries) => pushed.push(entries));
    r.shellExited("sh_1", "exited", 2);
    expect(pushed.at(-1)?.[0]).toMatchObject({ status: "exited", exit: 2 });
  });
});

describe("PreviewRegistry persistence", () => {
  it("brings running entries back after a restart and re-checks them", async () => {
    const file = join(
      mkdtempSync(join(tmpdir(), "previews-")),
      "previews.json",
    );
    const shells = fakeShells();
    const before = registry(shells, file);
    await before.start(DIR, { name: "web", command: "bun run dev" }, "ses_a");
    await before.open(DIR, "web", "http://localhost:5173/", "ses_a");
    await before.start(DIR, { name: "api", command: "bun api.ts" }, "ses_a");
    await before.start(DIR, { name: "old", command: "bun old.ts" });
    await before.stop(DIR, "old");
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveLength(3);

    shells.exit("sh_2", 0); // api, while the daemon was down
    const after = registry(shells, file);
    await after.rebuild(DIR);
    const entries = await after.entries(DIR);
    expect(entries.map((e) => [e.name, e.status])).toEqual([
      ["web", "running"],
      ["api", "exited"],
    ]);
    expect(entries[0]).toMatchObject({
      url: "http://localhost:5173/",
      opened: { sessionID: "ses_a" },
    });
  });
});

describe("isThisMachine", () => {
  it("knows loopback and *.localhost, not other hosts", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "[::1]",
      "app.localhost",
      "0.0.0.0",
    ])
      expect(isThisMachine(host)).toBe(true);
    for (const host of ["example.com", "abc.trycloudflare.com", "8.8.8.8"])
      expect(isThisMachine(host)).toBe(false);
  });
});
