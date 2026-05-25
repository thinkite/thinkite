import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildNewSidecodeSession,
  listSidecodeSessions,
  readSidecodeSession,
  sidecodeSessionPath,
  updateSidecodeSessionSelection,
  updateSidecodeSessionTitle,
  writeSidecodeSession,
} from "./sidecode-sessions.js";

describe("buildNewSidecodeSession", () => {
  it("uses local_<cliSessionId> as sessionId; same cwd as originCwd; firstPrompt becomes title", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "abc-123",
      cwd: "/Users/me/proj",
      firstPrompt: "Refactor the auth module",
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
    expect(meta.title).toBe("Refactor the auth module");
    expect(meta.titleSource).toBe("auto");
    expect(meta.permissionMode).toBe("bypassPermissions");
  });

  it("collapses newlines and excess whitespace in firstPrompt to a single line", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/x",
      firstPrompt: "Hello\n\nworld\n   how are you?",
    });
    expect(meta.title).toBe("Hello world how are you?");
  });

  it("trims surrounding whitespace from firstPrompt", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/x",
      firstPrompt: "   leading and trailing   ",
    });
    expect(meta.title).toBe("leading and trailing");
  });

  it("truncates with an ellipsis when firstPrompt exceeds 200 chars", () => {
    const long = "A".repeat(250);
    const meta = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/x",
      firstPrompt: long,
    });
    expect(meta.title.length).toBe(200);
    expect(meta.title.endsWith("…")).toBe(true);
    expect(meta.title.slice(0, 199)).toBe("A".repeat(199));
  });

  it("defaults `now` to Date.now()", () => {
    const before = Date.now();
    const meta = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/x",
      firstPrompt: "anything",
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
      firstPrompt: "Hello",
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
      firstPrompt: "Hello",
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
      firstPrompt: "old",
      now: 1,
    });
    writeSidecodeSession(home, a);
    const b = buildNewSidecodeSession({
      cliSessionId: "ow",
      cwd: "/new",
      firstPrompt: "new",
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

describe("readSidecodeSession", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-read-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns the persisted record", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "abc",
      cwd: "/proj",
      firstPrompt: "first",
      now: 100,
    });
    writeSidecodeSession(home, meta);
    expect(readSidecodeSession(home, "abc")).toEqual(meta);
  });

  it("returns undefined when the file is missing", () => {
    expect(readSidecodeSession(home, "nope")).toBeUndefined();
  });

  it("returns undefined when the file is malformed JSON", () => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(sidecodeSessionPath(home, "broken"), "{not-json", {
      mode: 0o600,
    });
    expect(readSidecodeSession(home, "broken")).toBeUndefined();
  });
});

describe("listSidecodeSessions", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-list-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns [] when sessions/ directory doesn't exist", () => {
    expect(listSidecodeSessions(home)).toEqual([]);
  });

  it("returns every local_*.json record", () => {
    writeSidecodeSession(
      home,
      buildNewSidecodeSession({
        cliSessionId: "a",
        cwd: "/x",
        firstPrompt: "p",
        now: 1,
      }),
    );
    writeSidecodeSession(
      home,
      buildNewSidecodeSession({
        cliSessionId: "b",
        cwd: "/y",
        firstPrompt: "p",
        now: 2,
      }),
    );
    const out = listSidecodeSessions(home);
    expect(out.map((s) => s.cliSessionId).sort()).toEqual(["a", "b"]);
  });

  it("filters by exact cwd when opts.cwd provided", () => {
    writeSidecodeSession(
      home,
      buildNewSidecodeSession({
        cliSessionId: "a",
        cwd: "/x",
        firstPrompt: "p",
        now: 1,
      }),
    );
    writeSidecodeSession(
      home,
      buildNewSidecodeSession({
        cliSessionId: "b",
        cwd: "/y",
        firstPrompt: "p",
        now: 2,
      }),
    );
    const out = listSidecodeSessions(home, { cwd: "/y" });
    expect(out.map((s) => s.cliSessionId)).toEqual(["b"]);
  });

  it("skips files that don't match local_*.json", () => {
    mkdirSync(join(home, "sessions"), { recursive: true });
    writeFileSync(join(home, "sessions", "README"), "unrelated");
    writeFileSync(join(home, "sessions", "remote_xyz.json"), "{}");
    expect(listSidecodeSessions(home)).toEqual([]);
  });

  it("skips malformed JSON files silently (one bad file doesn't break the listing)", () => {
    writeSidecodeSession(
      home,
      buildNewSidecodeSession({
        cliSessionId: "good",
        cwd: "/x",
        firstPrompt: "p",
        now: 1,
      }),
    );
    writeFileSync(sidecodeSessionPath(home, "bad"), "{broken", {
      mode: 0o600,
    });
    const out = listSidecodeSessions(home);
    expect(out.map((s) => s.cliSessionId)).toEqual(["good"]);
  });
});

describe("updateSidecodeSessionTitle", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-update-title-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("writes a new title with titleSource auto", () => {
    writeSidecodeSession(
      home,
      buildNewSidecodeSession({
        cliSessionId: "x",
        cwd: "/p",
        firstPrompt: "initial",
        now: 1,
      }),
    );
    const result = updateSidecodeSessionTitle(home, "x", "Renamed");
    expect(result).toBe("Renamed");
    const after = readSidecodeSession(home, "x");
    expect(after?.title).toBe("Renamed");
    expect(after?.titleSource).toBe("auto");
  });

  it("preserves other fields on title-only update", () => {
    const initial = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "first",
      now: 100,
    });
    writeSidecodeSession(home, initial);
    updateSidecodeSessionTitle(home, "x", "Some title");
    const after = readSidecodeSession(home, "x");
    expect(after?.cwd).toBe("/p");
    expect(after?.createdAt).toBe(100);
    expect(after?.permissionMode).toBe(initial.permissionMode);
  });

  it("is a no-op when titleSource is 'user' (lock honored)", () => {
    const initial = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "initial",
      now: 1,
    });
    writeSidecodeSession(home, {
      ...initial,
      title: "User name",
      titleSource: "user",
    });
    const result = updateSidecodeSessionTitle(home, "x", "Auto would clobber");
    expect(result).toBe("User name");
    const after = readSidecodeSession(home, "x");
    expect(after?.title).toBe("User name");
    expect(after?.titleSource).toBe("user");
  });

  it("returns '' and writes nothing when metadata doesn't exist", () => {
    const result = updateSidecodeSessionTitle(home, "ghost", "ignored");
    expect(result).toBe("");
    expect(existsSync(sidecodeSessionPath(home, "ghost"))).toBe(false);
  });
});

describe("buildNewSidecodeSession — model + effort", () => {
  it("persists model and effort when provided", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "hi",
      model: "claude-opus-4-7[1m]",
      effort: "xhigh",
    });
    expect(meta.model).toBe("claude-opus-4-7[1m]");
    expect(meta.effort).toBe("xhigh");
  });

  it("omits both fields when neither is provided (Haiku / pre-picker case)", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "hi",
    });
    expect(meta).not.toHaveProperty("model");
    expect(meta).not.toHaveProperty("effort");
  });

  it("can carry model alone (Haiku-tier model, no effort)", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "hi",
      model: "claude-haiku-4-5-20251001",
    });
    expect(meta.model).toBe("claude-haiku-4-5-20251001");
    expect(meta.effort).toBeUndefined();
  });
});

describe("updateSidecodeSessionSelection", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sidecode-sessions-sel-"));
  });
  afterEach(() => {
    if (existsSync(home)) rmSync(home, { recursive: true, force: true });
  });

  it("writes model + effort into existing metadata", () => {
    const initial = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "init",
    });
    writeSidecodeSession(home, initial);
    const result = updateSidecodeSessionSelection(home, "x", {
      model: "claude-opus-4-7[1m]",
      effort: "xhigh",
    });
    expect(result?.model).toBe("claude-opus-4-7[1m]");
    expect(result?.effort).toBe("xhigh");
    const onDisk = readSidecodeSession(home, "x");
    expect(onDisk?.model).toBe("claude-opus-4-7[1m]");
    expect(onDisk?.effort).toBe("xhigh");
  });

  it("preserves other fields (title / cwd / createdAt) unchanged", () => {
    const initial = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "Important task",
      now: 1_700_000_000_000,
    });
    writeSidecodeSession(home, initial);
    updateSidecodeSessionSelection(home, "x", { model: "m", effort: "high" });
    const after = readSidecodeSession(home, "x");
    expect(after?.title).toBe("Important task");
    expect(after?.cwd).toBe("/p");
    expect(after?.createdAt).toBe(1_700_000_000_000);
  });

  it("partial update: model only leaves effort alone", () => {
    const initial = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "init",
      model: "old-model",
      effort: "high",
    });
    writeSidecodeSession(home, initial);
    updateSidecodeSessionSelection(home, "x", { model: "new-model" });
    const after = readSidecodeSession(home, "x");
    expect(after?.model).toBe("new-model");
    expect(after?.effort).toBe("high");
  });

  it("returns undefined and writes nothing when metadata doesn't exist", () => {
    const result = updateSidecodeSessionSelection(home, "ghost", {
      model: "m",
      effort: "high",
    });
    expect(result).toBeUndefined();
    expect(existsSync(sidecodeSessionPath(home, "ghost"))).toBe(false);
  });
});
