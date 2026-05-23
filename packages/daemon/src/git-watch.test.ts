import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type GitStatus, GitWatcher } from "./git-watch.js";

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

  it("counts insertions vs HEAD when working tree is dirty (no upstream)", async () => {
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
    // No upstream → comparison ref falls back to HEAD, so this
    // measures uncommitted working-tree changes only.
    expect(status.insertions).toBe(2);
    expect(status.deletions).toBe(0);
    w.dispose();
  });

  it("counts untracked file lines on top of tracked diff", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "tracked.txt"), "x\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    // Modify tracked file → 1 insertion via `git diff`.
    writeFileSync(path.join(dir, "tracked.txt"), "x\ny\n");
    // Untracked file with 5 lines → 5 additions, summed in separately.
    writeFileSync(path.join(dir, "new.txt"), "a\nb\nc\nd\ne\n");

    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.isRepo).toBe(true);
    expect(status.isDirty).toBe(true);
    expect(status.insertions).toBe(1 + 5);
    expect(status.deletions).toBe(0);
    w.dispose();
  });

  it("skips binary files when counting untracked additions", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "marker.txt"), "x\n");
    execFileSync("git", ["add", "marker.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    // Untracked text file (3 lines) — should be counted.
    writeFileSync(path.join(dir, "added.txt"), "a\nb\nc\n");
    // Untracked binary-ish file (contains a null byte in first 512
    // bytes) — should be skipped by the sniff.
    writeFileSync(path.join(dir, "binary.bin"), Buffer.from([1, 0, 2, 3]));

    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.insertions).toBe(3);
    w.dispose();
  });

  it("flips isDirty true when only untracked files exist", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "tracked.txt"), "x\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    // No working-tree edit on a tracked file — only an untracked add.
    writeFileSync(path.join(dir, "new.txt"), "a\nb\n");

    const w = new GitWatcher(dir);
    const status = await w.refresh();
    expect(status.isDirty).toBe(true);
    expect(status.insertions).toBe(2);
    w.dispose();
  });

  it("subscribe is pure registration — no initial snapshot fires", async () => {
    initRepo(dir);
    writeFileSync(path.join(dir, "a.txt"), "x\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "first"], { cwd: dir });

    const w = new GitWatcher(dir);
    const got: GitStatus[] = [];
    const unsubscribe = w.subscribe((s) => got.push(s));
    // refresh() is the read API. The listener only sees subsequent
    // change-triggered pushes (debounced + invalidated cache).
    const snapshot = await w.refresh();
    // Drain any stray microtasks that might have queued a push.
    await new Promise((r) => setImmediate(r));
    expect(snapshot.branch).toBe("main");
    expect(snapshot.isDirty).toBe(false);
    expect(got).toEqual([]);
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
