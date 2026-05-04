import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildNewSidecodeSession,
  sidecodeSessionPath,
  writeSidecodeSession,
} from "./sidecode-sessions.js";

describe("buildNewSidecodeSession", () => {
  it("uses local_<cliSessionId> as sessionId; same cwd as originCwd", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "abc-123",
      cwd: "/Users/me/proj",
      now: 1_700_000_000_000,
    });
    expect(meta.sessionId).toBe("local_abc-123");
    expect(meta.cliSessionId).toBe("abc-123");
    expect(meta.cwd).toBe("/Users/me/proj");
    expect(meta.originCwd).toBe("/Users/me/proj");
    expect(meta.createdAt).toBe(1_700_000_000_000);
    expect(meta.lastActivityAt).toBe(1_700_000_000_000);
    expect(meta.isArchived).toBe(false);
    expect(meta.completedTurns).toBe(0);
    expect(meta.title).toBe("");
    expect(meta.titleSource).toBe("auto");
    expect(meta.permissionMode).toBe("bypassPermissions");
  });

  it("defaults `now` to Date.now()", () => {
    const before = Date.now();
    const meta = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/x",
    });
    const after = Date.now();
    expect(meta.createdAt).toBeGreaterThanOrEqual(before);
    expect(meta.createdAt).toBeLessThanOrEqual(after);
  });
});

describe("sidecodeSessionPath", () => {
  it("composes <home>/sessions/local_<cliSessionId>.json", () => {
    expect(sidecodeSessionPath("/home", "uuid-1")).toBe(
      "/home/sessions/local_uuid-1.json",
    );
  });
});

describe("writeSidecodeSession", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-sessions-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("creates sessions/ on first write and writes the JSON file", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "first",
      cwd: "/proj",
      now: 1_700_000_000_000,
    });
    expect(existsSync(join(home, "sessions"))).toBe(false);
    writeSidecodeSession(home, meta);
    const path = sidecodeSessionPath(home, "first");
    expect(existsSync(path)).toBe(true);
    const written = JSON.parse(readFileSync(path, "utf8"));
    expect(written).toEqual(meta);
  });

  it("uses 0600 perms on the written file (matches known_clients)", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "perms",
      cwd: "/proj",
    });
    writeSidecodeSession(home, meta);
    const path = sidecodeSessionPath(home, "perms");
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("overwrites an existing file (atomic .tmp + rename, idempotent caller)", () => {
    const a = buildNewSidecodeSession({
      cliSessionId: "ow",
      cwd: "/old",
      now: 1,
    });
    writeSidecodeSession(home, a);
    const b = buildNewSidecodeSession({
      cliSessionId: "ow",
      cwd: "/new",
      now: 2,
    });
    writeSidecodeSession(home, b);
    const written = JSON.parse(
      readFileSync(sidecodeSessionPath(home, "ow"), "utf8"),
    );
    expect(written.cwd).toBe("/new");
    expect(written.createdAt).toBe(2);
    // .tmp doesn't linger after rename.
    expect(existsSync(`${sidecodeSessionPath(home, "ow")}.tmp`)).toBe(false);
  });
});
