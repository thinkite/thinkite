import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PreviewEntry } from "@thinkite/protocol";
import { describe, expect, it } from "vitest";
import { isThisMachine, PreviewRegistry } from "./registry.ts";
import type { ShellApi, ShellInfo } from "./shells.ts";

const DIR = "/proj";

/** opencode's shells in memory, as the agent's shell tool leaves them:
 *  `spawn` is a background command whose process tree listens on `ports`. */
function fakeShells() {
  const shells = new Map<string, ShellInfo>();
  const ports = new Map<number, number[]>();
  let next = 1;
  const api: ShellApi = {
    async get(_directory, id) {
      return shells.get(id) ?? null;
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
    spawn(command: string, listening: number[] = []): string {
      const id = `sh_${next}`;
      const pid = 1000 + next;
      next += 1;
      shells.set(id, {
        id,
        status: "running",
        command,
        cwd: DIR,
        pid,
        metadata: { sessionID: "ses_a" },
        time: { started: 1 },
      });
      ports.set(pid, listening);
      return id;
    },
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
    ...(stateFile === undefined ? {} : { stateFile }),
  });
}

const tick = () => new Promise((r) => setTimeout(r, 2));

describe("PreviewRegistry.open", () => {
  it("registers a page its shell serves and asks to show it", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const sh = shells.spawn("bun run dev", [5173, 24678]);
    const out = await r.open(
      DIR,
      { name: "web", shellID: sh, url: "http://localhost:5173" },
      "ses_a",
    );
    expect(out).toEqual({
      text: `Registered "web" at http://localhost:5173/. Sent to the user's browser.`,
    });
    const [entry] = await r.entries(DIR);
    expect(entry).toMatchObject({
      name: "web",
      url: "http://localhost:5173/",
      status: "running",
      command: "bun run dev",
      sessions: ["ses_a"],
      opened: { sessionID: "ses_a" },
    });
  });

  it("registers a backend without showing it when open is false", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const sh = shells.spawn("bun api.ts", [8787]);
    const out = await r.open(
      DIR,
      { name: "api", shellID: sh, url: "http://127.0.0.1:8787/", open: false },
      "ses_a",
    );
    expect(out.text).toBe(
      `Registered "api" at http://127.0.0.1:8787/ (not opened).`,
    );
    expect((await r.entries(DIR))[0]?.opened).toBeUndefined();
  });

  it("refuses a local URL its shell does not listen on, and says where it does", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const moved = shells.spawn("vite", [5174]);
    expect(
      await r.open(DIR, {
        name: "web",
        shellID: moved,
        url: "http://localhost:5173/",
      }),
    ).toEqual({
      text: `Shell ${moved} is not listening on 5173 (it listens on 5174). Nothing was opened.`,
      isError: true,
    });
    const early = shells.spawn("next dev");
    const out = await r.open(DIR, {
      name: "web",
      shellID: early,
      url: "http://localhost:3000/",
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("not listening on 3000 yet");
    expect(await r.entries(DIR)).toEqual([]);
  });

  it("takes a tunnel or public URL as given", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const sh = shells.spawn("cloudflared tunnel --url http://localhost:5173");
    const out = await r.open(
      DIR,
      { name: "tunnel", shellID: sh, url: "https://abc.trycloudflare.com" },
      "ses_a",
    );
    expect(out.isError).toBeFalsy();
    expect((await r.entries(DIR))[0]?.url).toBe(
      "https://abc.trycloudflare.com/",
    );
  });

  it("needs a running shell of this project and an http(s) URL", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    expect(
      (
        await r.open(DIR, {
          name: "web",
          shellID: "sh_9",
          url: "http://localhost:1/",
        })
      ).text,
    ).toContain("No shell sh_9 in this project");
    const sh = shells.spawn("bun run dev", [5173]);
    shells.exit(sh, 1);
    expect(
      (
        await r.open(DIR, {
          name: "web",
          shellID: sh,
          url: "http://localhost:5173/",
        })
      ).text,
    ).toBe(`Shell ${sh} is not running (exited, code 1). Check its output.`);
    const live = shells.spawn("bun run dev", [5173]);
    expect(
      await r.open(DIR, {
        name: "web",
        shellID: live,
        url: "file:///tmp/a.html",
      }),
    ).toEqual({ text: "The URL must be http or https.", isError: true });
  });

  it("shows the same server again with a new stamp, and adds the session", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const sh = shells.spawn("bun run dev", [5173]);
    const input = { name: "web", shellID: sh, url: "http://localhost:5173/" };
    await r.open(DIR, input, "ses_a");
    const first = (await r.entries(DIR))[0]?.opened?.at ?? 0;
    await tick();
    await r.open(DIR, input, "ses_b");
    const [entry] = await r.entries(DIR);
    expect(entry?.opened?.sessionID).toBe("ses_b");
    expect(entry?.opened?.at).toBeGreaterThan(first);
    expect(entry?.sessions).toEqual(["ses_a", "ses_b"]);
  });

  it("refuses another shell for a running name, and replaces an ended one", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const a = shells.spawn("bun run dev", [5173]);
    const b = shells.spawn("bun run dev -- --port 5175", [5175]);
    await r.open(DIR, {
      name: "web",
      shellID: a,
      url: "http://localhost:5173/",
    });
    const refused = await r.open(DIR, {
      name: "web",
      shellID: b,
      url: "http://localhost:5175/",
    });
    expect(refused).toEqual({
      text: `"web" is shell ${a}, still running; call preview_stop first or use another name.`,
      isError: true,
    });
    shells.exit(a, 0);
    expect(
      (
        await r.open(DIR, {
          name: "web",
          shellID: b,
          url: "http://localhost:5175/",
        })
      ).isError,
    ).toBeFalsy();
    expect((await r.entries(DIR))[0]?.url).toBe("http://localhost:5175/");
  });
});

describe("PreviewRegistry.list / stop", () => {
  it("lists the caller's servers by default and counts the rest", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const web = shells.spawn("bun run dev", [5173]);
    const api = shells.spawn("bun api.ts", [8787]);
    await r.open(
      DIR,
      { name: "web", shellID: web, url: "http://localhost:5173/" },
      "ses_a",
    );
    await r.open(
      DIR,
      { name: "api", shellID: api, url: "http://localhost:8787/", open: false },
      "ses_b",
    );
    expect((await r.list(DIR, "ses_a")).text).toBe(
      `web: http://localhost:5173/ — running, shown to the user — shell ${web}, \`bun run dev\`\n` +
        "1 more in this project (pass all: true).",
    );
    expect((await r.list(DIR, "ses_a", true)).text.split("\n")).toHaveLength(2);
  });

  it("shows a dead server as exited", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const sh = shells.spawn("bun run dev", [5173]);
    await r.open(DIR, {
      name: "web",
      shellID: sh,
      url: "http://localhost:5173/",
    });
    shells.exit(sh, 137);
    expect((await r.list(DIR)).text).toBe(
      `web: exited (code 137) — shell ${sh}, \`bun run dev\``,
    );
  });

  it("stops the shell, keeps the entry as killed and names the other sessions", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const sh = shells.spawn("bun run dev", [5173]);
    const input = { name: "web", shellID: sh, url: "http://localhost:5173/" };
    await r.open(DIR, input, "ses_a");
    await r.open(DIR, input, "ses_b");
    expect((await r.stop(DIR, "web", "ses_a")).text).toBe(
      `Stopped "web". It was also in use by 1 other session(s); it stopped for them too.`,
    );
    expect((await r.entries(DIR))[0]?.status).toBe("killed");
    expect((await r.stop(DIR, "web")).text).toBe(
      `"web" is not running (killed).`,
    );
    expect((await r.stop(DIR, "nope")).isError).toBe(true);
  });

  it("pushes shell.exited to subscribers", async () => {
    const shells = fakeShells();
    const r = registry(shells);
    const sh = shells.spawn("bun run dev", [5173]);
    await r.open(DIR, {
      name: "web",
      shellID: sh,
      url: "http://localhost:5173/",
    });
    const pushed: PreviewEntry[][] = [];
    r.subscribe(DIR, (entries) => pushed.push(entries));
    r.shellExited(sh, "exited", 2);
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
    const web = shells.spawn("bun run dev", [5173]);
    const api = shells.spawn("bun api.ts", [8787]);
    const gone = shells.spawn("bun old.ts", [9000]);
    await before.open(
      DIR,
      { name: "web", shellID: web, url: "http://localhost:5173/" },
      "ses_a",
    );
    await before.open(
      DIR,
      { name: "api", shellID: api, url: "http://localhost:8787/" },
      "ses_a",
    );
    await before.open(DIR, {
      name: "old",
      shellID: gone,
      url: "http://localhost:9000/",
    });
    await before.stop(DIR, "old");
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveLength(3);

    shells.exit(api, 0); // while the daemon was down
    const after = registry(shells, file);
    await after.rebuild(DIR);
    const entries = await after.entries(DIR);
    expect(entries.map((e) => [e.name, e.status])).toEqual([
      ["web", "running"],
      ["api", "exited"],
    ]);
    expect(entries[0]?.opened?.sessionID).toBe("ses_a");
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
