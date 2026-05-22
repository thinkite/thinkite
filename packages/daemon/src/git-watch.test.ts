import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitWatcher } from "./git-watch.js";

/**
 * Real-git integration tests. `simple-git` is itself just a `git` CLI
 * wrapper, so mocking it would test our mocks more than the contract.
 * tmpdir + a one-off init keeps each test isolated.
 *
 * fs.watch + debounce path is not exercised here — verifying real watch
 * events fire within a deterministic window is flaky, and the unit being
 * fragile is fs.watch itself, not our code. Self-heal + debounce timing
 * are covered by their direct callers.
 */
describe("GitWatcher", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "sidecode-git-watch-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function initRepo(repoDir: string): void {
    // -b main avoids depending on the user's `init.defaultBranch` config.
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repoDir });
    // Local identity so commits don't error on hosts without global config.
    execFileSync("git", ["config", "user.email", "test@sidecode.app"], {
      cwd: repoDir,
    });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
  }

  it("reports isRepo:false for a non-git directory", async () => {
    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.isRepo).toBe(false);
    expect(status.project).toBe(path.basename(dir));
    expect(status.branch).toBeNull();
    expect(status.insertions).toBe(0);
    expect(status.deletions).toBe(0);
    expect(status.isDirty).toBe(false);
    w.dispose();
  });

  it("reports branch + clean state after an initial commit", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.isRepo).toBe(true);
    expect(status.branch).toBe("main");
    expect(status.isDirty).toBe(false);
    expect(status.insertions).toBe(0);
    expect(status.deletions).toBe(0);
    expect(status.ahead).toBe(0);
    expect(status.behind).toBe(0);
    w.dispose();
  });

  it("counts insertions vs HEAD when working tree is dirty", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "line1\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });
    // Two new lines on top of the committed one.
    writeFileSync(path.join(dir, "a.txt"), "line1\nline2\nline3\n");

    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.isRepo).toBe(true);
    expect(status.isDirty).toBe(true);
    expect(status.insertions).toBe(2);
    expect(status.deletions).toBe(0);
    w.dispose();
  });

  it("delivers the initial snapshot to a subscriber", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "x\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    const w = new GitWatcher(dir);
    const got: Array<{ branch: string | null; isDirty: boolean }> = [];
    const unsubscribe = w.subscribe((s) =>
      got.push({ branch: s.branch, isDirty: s.isDirty }),
    );
    // subscribe pushes async — give the in-flight refresh a tick.
    await w.refresh();
    // One small extra tick to drain the resolve-after-cache microtask.
    await new Promise((r) => setImmediate(r));
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(got[0]).toEqual({ branch: "main", isDirty: false });
    unsubscribe();
    w.dispose();
  });

  it("dispose() is idempotent", () => {
    const w = new GitWatcher(dir);
    w.dispose();
    w.dispose();
    // subscribing after dispose throws — protects against stale callers.
    expect(() => w.subscribe(() => undefined)).toThrow();
  });
});
