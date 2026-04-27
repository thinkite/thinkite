import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  desktopSessionsRoot,
  listDesktopSessions,
} from "./sessions.js";

const OUTER_A = "5e7e6b95-3ce4-4a96-ba41-b12692e3924d";
const INNER_A = "26c09711-7746-482e-a18e-6a754d683aae";
const OUTER_B = "d26c535b-53f1-40e2-b1da-71b273fb2193";
const INNER_B = "6328b49e-5009-4dc3-922f-acecfbb13e02";

interface SessionFile {
  outer: string;
  inner: string;
  fileName: string;
  body: Record<string, unknown>;
}

function writeSession(root: string, f: SessionFile): string {
  const dir = join(root, f.outer, f.inner);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, f.fileName);
  writeFileSync(filePath, JSON.stringify(f.body));
  return filePath;
}

function makeSessionBody(overrides: Partial<Record<string, unknown>>) {
  return {
    sessionId: "local_default",
    cliSessionId: "cli-default",
    cwd: "/Users/x/proj",
    originCwd: "/Users/x/proj",
    createdAt: 1000,
    lastActivityAt: 1000,
    model: "claude-opus-4-7[1m]",
    effort: "xhigh",
    isArchived: false,
    title: "default",
    titleSource: "auto",
    permissionMode: "bypassPermissions",
    completedTurns: 0,
    ...overrides,
  };
}

describe("listDesktopSessions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sidecode-desktop-test-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns [] when root dir does not exist", async () => {
    const missing = join(root, "nonexistent");
    const result = await listDesktopSessions({
      cwd: "/Users/x/proj",
      rootOverride: missing,
    });
    expect(result).toEqual([]);
  });

  it("returns [] when root is empty", async () => {
    const result = await listDesktopSessions({
      cwd: "/Users/x/proj",
      rootOverride: root,
    });
    expect(result).toEqual([]);
  });

  it("returns a single matching session", async () => {
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_abc.json",
      body: makeSessionBody({
        sessionId: "local_abc",
        cwd: "/Users/x/proj",
        title: "Hit",
      }),
    });
    const result = await listDesktopSessions({
      cwd: "/Users/x/proj",
      rootOverride: root,
    });
    expect(result).toHaveLength(1);
    expect(result[0]?.sessionId).toBe("local_abc");
    expect(result[0]?.title).toBe("Hit");
    expect(result[0]?.environmentOuter).toBe(OUTER_A);
    expect(result[0]?.environmentInner).toBe(INNER_A);
  });

  it("filters out non-matching cwds in the same env", async () => {
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_match.json",
      body: makeSessionBody({ sessionId: "local_match", cwd: "/p/match" }),
    });
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_other.json",
      body: makeSessionBody({ sessionId: "local_other", cwd: "/p/other" }),
    });
    const result = await listDesktopSessions({
      cwd: "/p/match",
      rootOverride: root,
    });
    expect(result.map((s) => s.sessionId)).toEqual(["local_match"]);
  });

  it("walks multiple environment dirs", async () => {
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_a.json",
      body: makeSessionBody({
        sessionId: "local_a",
        cwd: "/p",
        lastActivityAt: 100,
      }),
    });
    writeSession(root, {
      outer: OUTER_B,
      inner: INNER_B,
      fileName: "local_b.json",
      body: makeSessionBody({
        sessionId: "local_b",
        cwd: "/p",
        lastActivityAt: 200,
      }),
    });
    const result = await listDesktopSessions({
      cwd: "/p",
      rootOverride: root,
    });
    expect(result.map((s) => s.sessionId)).toEqual(["local_b", "local_a"]);
  });

  it("sorts by lastActivityAt descending", async () => {
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_old.json",
      body: makeSessionBody({
        sessionId: "local_old",
        cwd: "/p",
        lastActivityAt: 100,
      }),
    });
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_new.json",
      body: makeSessionBody({
        sessionId: "local_new",
        cwd: "/p",
        lastActivityAt: 999,
      }),
    });
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_mid.json",
      body: makeSessionBody({
        sessionId: "local_mid",
        cwd: "/p",
        lastActivityAt: 500,
      }),
    });
    const result = await listDesktopSessions({
      cwd: "/p",
      rootOverride: root,
    });
    expect(result.map((s) => s.sessionId)).toEqual([
      "local_new",
      "local_mid",
      "local_old",
    ]);
  });

  it("skips malformed JSON files but returns the rest", async () => {
    const dir = join(root, OUTER_A, INNER_A);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "local_broken.json"), "{not valid json");
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_ok.json",
      body: makeSessionBody({ sessionId: "local_ok", cwd: "/p" }),
    });
    const result = await listDesktopSessions({
      cwd: "/p",
      rootOverride: root,
    });
    expect(result.map((s) => s.sessionId)).toEqual(["local_ok"]);
  });

  it("skips files missing required fields", async () => {
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_no_cwd.json",
      body: { sessionId: "local_no_cwd" },
    });
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_no_id.json",
      body: { cwd: "/p" },
    });
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_ok.json",
      body: makeSessionBody({ sessionId: "local_ok", cwd: "/p" }),
    });
    const result = await listDesktopSessions({
      cwd: "/p",
      rootOverride: root,
    });
    expect(result.map((s) => s.sessionId)).toEqual(["local_ok"]);
  });

  it("ignores non-local_*.json files in the inner dir", async () => {
    const dir = join(root, OUTER_A, INNER_A);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "metadata.json"), "{}");
    writeFileSync(join(dir, "local_session.txt"), "ignore");
    writeFileSync(join(dir, ".DS_Store"), "");
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_keep.json",
      body: makeSessionBody({ sessionId: "local_keep", cwd: "/p" }),
    });
    const result = await listDesktopSessions({
      cwd: "/p",
      rootOverride: root,
    });
    expect(result.map((s) => s.sessionId)).toEqual(["local_keep"]);
  });

  it("preserves originCwd for forked sessions", async () => {
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_fork.json",
      body: makeSessionBody({
        sessionId: "local_fork",
        cwd: "/p/worktree",
        originCwd: "/p",
      }),
    });
    const result = await listDesktopSessions({
      cwd: "/p/worktree",
      rootOverride: root,
    });
    expect(result[0]?.cwd).toBe("/p/worktree");
    expect(result[0]?.originCwd).toBe("/p");
  });

  it("falls back originCwd to cwd when missing", async () => {
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_noorigin.json",
      body: {
        sessionId: "local_noorigin",
        cwd: "/p",
        lastActivityAt: 1,
      },
    });
    const result = await listDesktopSessions({
      cwd: "/p",
      rootOverride: root,
    });
    expect(result[0]?.originCwd).toBe("/p");
  });

  it("returns sessions across all cwds when cwd is omitted", async () => {
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_a.json",
      body: makeSessionBody({
        sessionId: "local_a",
        cwd: "/p/one",
        lastActivityAt: 100,
      }),
    });
    writeSession(root, {
      outer: OUTER_A,
      inner: INNER_A,
      fileName: "local_b.json",
      body: makeSessionBody({
        sessionId: "local_b",
        cwd: "/p/two",
        lastActivityAt: 200,
      }),
    });
    writeSession(root, {
      outer: OUTER_B,
      inner: INNER_B,
      fileName: "local_c.json",
      body: makeSessionBody({
        sessionId: "local_c",
        cwd: "/p/three",
        lastActivityAt: 300,
      }),
    });
    const result = await listDesktopSessions({ rootOverride: root });
    expect(result.map((s) => s.sessionId)).toEqual([
      "local_c",
      "local_b",
      "local_a",
    ]);
  });

  it("treats no-arg call as 'all cwds, default root' (root missing → [])", async () => {
    // No fixtures written under the OS default Desktop path; this exercises
    // the both-defaults code path.
    const result = await listDesktopSessions();
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("desktopSessionsRoot", () => {
  it("joins homeDirOverride with the canonical Desktop path", () => {
    expect(desktopSessionsRoot("/fake/home")).toBe(
      "/fake/home/Library/Application Support/Claude/claude-code-sessions",
    );
  });
});
