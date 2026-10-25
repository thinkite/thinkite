import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import type { Command, DaemonFrame } from "@thinkite/protocol";
import { describe, expect, it, vi } from "vitest";
import type { CommandContext } from "./command.ts";
import { GitWatcherRegistry } from "./git-watch.ts";
import type { RecentSession } from "./opencode/recent.ts";
import { PreviewRegistry } from "./preview/registry.ts";
import type { ShellApi, ShellInfo } from "./preview/shells.ts";
import { createCommandHandler } from "./router.ts";

function makeCtx(): {
  ctx: CommandContext;
  sent: DaemonFrame[];
  fireDisconnect: () => void;
} {
  const sent: DaemonFrame[] = [];
  const callbacks: Array<() => void> = [];
  return {
    sent,
    fireDisconnect: () => {
      for (const cb of callbacks) cb();
      callbacks.length = 0;
    },
    ctx: {
      send: (f) => sent.push(f),
      fingerprint: "0123456789abcdef",
      onDisconnect: (cb) => {
        callbacks.push(cb);
      },
      state: new Map(),
    },
  };
}

/** Default deps for command-handler tests. */
function makeDeps(
  overrides?: Partial<Parameters<typeof createCommandHandler>[0]>,
): Parameters<typeof createCommandHandler>[0] {
  return {
    gitWatchers: new GitWatcherRegistry(),
    recentSessions: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe("createCommandHandler — unsupported commands", () => {
  it("replies error/unsupported with the inbound requestId", async () => {
    // Session commands moved to opencode; an old client that still sends
    // one falls through to the unsupported-default branch.
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "sendPrompt",
        requestId: "send-1",
        sessionId: "s",
        text: "hi",
      } as unknown as Command,
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "error",
      code: "unsupported",
    });
    expect((sent[0] as { requestId?: string }).requestId).toBe("send-1");
  });
});

describe("createCommandHandler — getGitStatus / subscribeGitStatus / unsubscribeGitStatus", () => {
  // Uses a real GitWatcherRegistry against a tmp non-git directory. The
  // happy snapshot for non-repo dirs is deterministic (`isRepo:false`,
  // all numeric fields zero) so we can assert the wire shape without
  // invoking the `git` binary or fs.watch.
  let cwd: string;
  let registry: GitWatcherRegistry;

  function makeGitDeps() {
    cwd = mkdtempSync(path.join(tmpdir(), "sidecode-router-git-"));
    registry = new GitWatcherRegistry();
    return makeDeps({ gitWatchers: registry });
  }

  function cleanup() {
    registry.disposeAll();
    rmSync(cwd, { recursive: true, force: true });
  }

  it("getGitStatus replies with a non-repo snapshot for a plain directory", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "getGitStatus", requestId: "g0", cwd } satisfies Command,
      ctx,
    );
    expect(sent).toEqual([
      {
        type: "getGitStatus.response",
        requestId: "g0",
        cwd,
        status: {
          isRepo: false,
          project: path.basename(cwd),
          branch: null,
          ahead: 0,
          behind: 0,
          insertions: 0,
          deletions: 0,
          isDirty: false,
        },
      },
    ]);
    // Snapshot-only never starts a watcher (no fs.watch leak).
    expect(registry.getOrCreate(cwd).listenerCount()).toBe(0);
    cleanup();
  });

  it("subscribeGitStatus acks WITHOUT an initial snapshot", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "subscribeGitStatus", requestId: "g1", cwd } satisfies Command,
      ctx,
    );
    expect(sent).toEqual([
      { type: "subscribeGitStatus.response", requestId: "g1", cwd },
    ]);
    cleanup();
  });

  it("unsubscribe responds even when nothing was subscribed", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "unsubscribeGitStatus",
        requestId: "g2",
        cwd,
      } satisfies Command,
      ctx,
    );
    expect(sent).toEqual([
      { type: "unsubscribeGitStatus.response", requestId: "g2" },
    ]);
    cleanup();
  });

  it("disconnect cleans up the per-conn subscription", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx, fireDisconnect } = makeCtx();
    await handler(
      { type: "subscribeGitStatus", requestId: "g3", cwd } satisfies Command,
      ctx,
    );
    const watcher = registry.getOrCreate(cwd);
    expect(watcher.listenerCount()).toBe(1);
    fireDisconnect();
    expect(watcher.listenerCount()).toBe(0);
    cleanup();
  });

  it("re-subscribe on same conn replaces the previous listener", async () => {
    const handler = createCommandHandler(makeGitDeps());
    const { ctx } = makeCtx();
    await handler(
      { type: "subscribeGitStatus", requestId: "g4a", cwd } satisfies Command,
      ctx,
    );
    await handler(
      { type: "subscribeGitStatus", requestId: "g4b", cwd } satisfies Command,
      ctx,
    );
    const watcher = registry.getOrCreate(cwd);
    // Two subscribe calls on the same connection should leave exactly
    // one listener attached, not two.
    expect(watcher.listenerCount()).toBe(1);
    cleanup();
  });
});

// ─── Filesystem browser (listDirectory + getFilesystemRoots) ─────────────────

/**
 * Build a fixture directory tree at a fresh tmpdir for browser tests:
 *
 *   <root>/
 *     alpha/                  ← subdirectory (alpha sort tester)
 *     beta/
 *     zebra/                  ← directory; lowercase sort vs Alpha
 *     .hidden/                ← hidden directory
 *     README.md               ← file
 *     .env                    ← hidden file
 *     image.png               ← file (predictable size)
 *
 * Returned helpers let each test populate exactly what it needs.
 */
function makeBrowserFixture(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(path.join(tmpdir(), "router-browser-"));
  for (const dir of ["alpha", "beta", "zebra", ".hidden"]) {
    mkdirSync(path.join(root, dir));
  }
  writeFileSync(path.join(root, "README.md"), "hello\n");
  writeFileSync(path.join(root, ".env"), "SECRET=x\n");
  writeFileSync(path.join(root, "image.png"), "fake-png-bytes");
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("createCommandHandler — listDirectory", () => {
  it("returns only directories by default, sorted alpha case-insensitive", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld1",
          path: root,
        } satisfies Command,
        ctx,
      );
      expect(sent).toHaveLength(1);
      const res = sent[0];
      expect(res.type).toBe("listDirectory.response");
      if (res.type !== "listDirectory.response") throw new Error("type guard");
      expect(res.path).toBe(root);
      expect(res.parent).toBe(path.dirname(root));
      // No files (default includeFiles=false), no hidden (default
      // includeHidden=false); alpha case-insensitive within kind:
      // alpha → beta → zebra.
      expect(res.entries.map((e) => e.name)).toEqual([
        "alpha",
        "beta",
        "zebra",
      ]);
      expect(res.entries.every((e) => e.kind === "directory")).toBe(true);
      // No stats on dir-only entries.
      expect(res.entries.every((e) => e.size === undefined)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("includes hidden entries when includeHidden=true (still no files by default)", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld2",
          path: root,
          includeHidden: true,
        } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "listDirectory.response")
        throw new Error("expected response");
      // .hidden directory now shown; .env file still filtered by !includeFiles.
      expect(sent[0].entries.map((e) => e.name)).toEqual([
        ".hidden",
        "alpha",
        "beta",
        "zebra",
      ]);
    } finally {
      cleanup();
    }
  });

  it("surfaces files (kind only, no size/modifiedAt in V0) when includeFiles=true", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld3",
          path: root,
          includeFiles: true,
        } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "listDirectory.response")
        throw new Error("expected response");
      // Dirs first (alpha, beta, zebra), then files (image.png, README.md).
      // .env / .hidden still filtered (no includeHidden).
      expect(sent[0].entries.map((e) => e.name)).toEqual([
        "alpha",
        "beta",
        "zebra",
        "image.png",
        "README.md",
      ]);
      const readme = sent[0].entries.find((e) => e.name === "README.md");
      expect(readme?.kind).toBe("file");
      // V0 deliberately leaves size + modifiedAt undefined; the per-
      // entry stat path is deferred until we know whether we want
      // per-call stat, lazy-on-visible-row, or native bulk-stat.
      expect(readme?.size).toBeUndefined();
      expect(readme?.modifiedAt).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("expands ~ to HOME", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "listDirectory", requestId: "ld4", path: "~" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "listDirectory.response")
      throw new Error("expected response");
    // Daemon should have resolved "~" to homedir; echoed path matches.
    expect(sent[0].path).toBe(homedir());
  });

  it("returns not_found error for ENOENT path", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      {
        type: "listDirectory",
        requestId: "ld5",
        path: "/nonexistent-path-for-test-abc123",
      } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "error") throw new Error("expected error frame");
    expect(sent[0].code).toBe("not_found");
    expect(sent[0].requestId).toBe("ld5");
  });

  it("returns not_a_directory error when path is a file", async () => {
    const { root, cleanup } = makeBrowserFixture();
    try {
      const handler = createCommandHandler(makeDeps());
      const { ctx, sent } = makeCtx();
      await handler(
        {
          type: "listDirectory",
          requestId: "ld6",
          path: path.join(root, "README.md"),
        } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "error") throw new Error("expected error frame");
      expect(sent[0].code).toBe("not_a_directory");
    } finally {
      cleanup();
    }
  });

  it("reports parent=null at the filesystem root", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "listDirectory", requestId: "ld7", path: "/" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "listDirectory.response")
      throw new Error("expected response");
    expect(sent[0].path).toBe("/");
    expect(sent[0].parent).toBeNull();
  });
});

describe("createCommandHandler — getFilesystemRoots", () => {
  const session = (directory: string, updatedAt: number): RecentSession => ({
    directory,
    updatedAt,
  });

  it("returns home/desktop/documents derived from os.homedir", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "getFilesystemRoots", requestId: "fr1" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "getFilesystemRoots.response")
      throw new Error("expected response");
    const home = homedir();
    expect(sent[0].home).toBe(home);
    // Desktop/Documents are OPTIONAL by contract: present iff the dir
    // exists on disk (macOS always has both; Linux CI runners have
    // neither). Mirror the handler's existence filter instead of
    // assuming a macOS-shaped $HOME.
    const desktop = path.join(home, "Desktop");
    expect(sent[0].desktop).toBe(existsSync(desktop) ? desktop : undefined);
    const documents = path.join(home, "Documents");
    expect(sent[0].documents).toBe(
      existsSync(documents) ? documents : undefined,
    );
    expect(sent[0].recentCwds).toEqual([]); // no sessions = no recents
  });

  it("aggregates recent folders from opencode sessions, deduped, existence-filtered, sorted desc", async () => {
    // Use tmpdir for existing cwds so the existence check actually
    // resolves on the real filesystem.
    const existingA = mkdtempSync(path.join(tmpdir(), "fr-cwdA-"));
    const existingB = mkdtempSync(path.join(tmpdir(), "fr-cwdB-"));
    const staleC = "/Users/nope/this-was-deleted-test-xyz";
    try {
      const handler = createCommandHandler(
        makeDeps({
          recentSessions: vi.fn().mockResolvedValue([
            // Two sessions in the same folder — dedupes to the LATEST
            // update (900 > 100).
            session(existingA, 1700000000100),
            session(existingA, 1700000000900),
            session(existingB, 1700000000500),
            // Stale path; should be dropped by existence filter.
            session(staleC, 1700000001000),
          ]),
        }),
      );
      const { ctx, sent } = makeCtx();
      await handler(
        { type: "getFilesystemRoots", requestId: "fr2" } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "getFilesystemRoots.response")
        throw new Error("expected response");
      // existingA wins existingB on update time (900 > 500); staleC dropped.
      expect(sent[0].recentCwds.map((r) => r.path)).toEqual([
        existingA,
        existingB,
      ]);
      // Dedup keeps the LATER update (900 > 100).
      expect(sent[0].recentCwds[0].lastUsedAt).toBe(
        new Date(1700000000900).toISOString(),
      );
    } finally {
      rmSync(existingA, { recursive: true, force: true });
      rmSync(existingB, { recursive: true, force: true });
    }
  });

  it("caps recentCwds at 10 even when more exist", async () => {
    const cwds: string[] = [];
    for (let i = 0; i < 15; i++) {
      cwds.push(mkdtempSync(path.join(tmpdir(), `fr-cap-${i}-`)));
    }
    try {
      const handler = createCommandHandler(
        makeDeps({
          recentSessions: vi
            .fn()
            .mockResolvedValue(
              cwds.map((cwd, i) => session(cwd, 1700000000000 + i)),
            ),
        }),
      );
      const { ctx, sent } = makeCtx();
      await handler(
        { type: "getFilesystemRoots", requestId: "fr3" } satisfies Command,
        ctx,
      );
      if (sent[0]?.type !== "getFilesystemRoots.response")
        throw new Error("expected response");
      expect(sent[0].recentCwds).toHaveLength(10);
      // Sorted desc means the LAST 10 we inserted come first.
      expect(sent[0].recentCwds[0].path).toBe(cwds[14]);
    } finally {
      for (const c of cwds) rmSync(c, { recursive: true, force: true });
    }
  });

  it("an unreachable opencode service gives no recents, not an error", async () => {
    const handler = createCommandHandler(
      makeDeps({
        recentSessions: vi.fn().mockRejectedValue(new Error("no service")),
      }),
    );
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "getFilesystemRoots", requestId: "fr4" } satisfies Command,
      ctx,
    );
    if (sent[0]?.type !== "getFilesystemRoots.response")
      throw new Error("expected response");
    expect(sent[0].recentCwds).toEqual([]);
  });
});

describe("createCommandHandler — previews", () => {
  // One running `web` server on 5180 in /proj.
  function previewRegistry(): PreviewRegistry {
    const shell: ShellInfo = {
      id: "sh_1",
      status: "running",
      command: "bun run dev",
      cwd: "/proj",
      pid: 4242,
      metadata: {},
      time: { started: 1 },
    };
    const shells: ShellApi = {
      create: async () => shell,
      get: async () => shell,
      list: async () => [shell],
      tail: async () => "",
      remove: async () => {
        shell.status = "killed";
      },
    };
    return new PreviewRegistry({
      shells,
      ports: async () => (shell.status === "running" ? [5180] : []),
      probe: async () => ({ kind: "page" }),
      sleep: async () => undefined,
    });
  }

  it("answers unsupported when the daemon has no registry", async () => {
    const handler = createCommandHandler(makeDeps());
    const { ctx, sent } = makeCtx();
    await handler(
      { type: "getPreviews", requestId: "r1", directory: "/proj" },
      ctx,
    );
    expect(sent).toEqual([
      expect.objectContaining({
        type: "error",
        requestId: "r1",
        code: "unsupported",
      }),
    ]);
  });

  it("pushes the list and previewOpened to a subscribed connection only", async () => {
    const previews = previewRegistry();
    const handler = createCommandHandler(makeDeps({ previews }));
    const a = makeCtx();
    const b = makeCtx();
    await handler(
      { type: "subscribePreviews", requestId: "r1", directory: "/proj" },
      a.ctx,
    );
    await handler(
      { type: "subscribePreviews", requestId: "r1", directory: "/other" },
      b.ctx,
    );
    await previews.start(
      "/proj",
      { name: "web", command: "bun run dev", open: true },
      "ses_a",
    );

    expect(a.sent[0]).toEqual({
      type: "subscribePreviews.response",
      requestId: "r1",
      directory: "/proj",
    });
    expect(a.sent.filter((f) => f.type === "previews").at(-1)).toMatchObject({
      directory: "/proj",
      entries: [
        { name: "web", status: "running", primaryPort: 5180, open: true },
      ],
    });
    expect(a.sent.filter((f) => f.type === "previewOpened")).toEqual([
      {
        type: "previewOpened",
        directory: "/proj",
        name: "web",
        sessionID: "ses_a",
        url: "http://localhost:5180/",
      },
    ]);
    expect(b.sent.map((f) => f.type)).toEqual(["subscribePreviews.response"]);

    a.fireDisconnect();
    await previews.start(
      "/proj",
      { name: "web", command: "bun run dev", open: true },
      "ses_a",
    );
    expect(a.sent.filter((f) => f.type === "previewOpened")).toHaveLength(1);
  });

  it("getPreviews snapshots and stopPreview stops", async () => {
    const previews = previewRegistry();
    const handler = createCommandHandler(makeDeps({ previews }));
    const { ctx, sent } = makeCtx();
    await previews.start("/proj", { name: "web", command: "bun run dev" });
    await handler(
      { type: "getPreviews", requestId: "r1", directory: "/proj" },
      ctx,
    );
    expect(sent[0]).toMatchObject({
      type: "getPreviews.response",
      entries: [{ name: "web" }],
    });
    await handler(
      { type: "stopPreview", requestId: "r2", directory: "/proj", name: "web" },
      ctx,
    );
    expect(sent[1]).toEqual({ type: "stopPreview.response", requestId: "r2" });
    await handler(
      { type: "stopPreview", requestId: "r3", directory: "/proj", name: "web" },
      ctx,
    );
    expect(sent[2]).toMatchObject({
      type: "error",
      requestId: "r3",
      code: "not_found",
    });
  });
});
