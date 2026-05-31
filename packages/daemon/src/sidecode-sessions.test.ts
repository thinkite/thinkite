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
  clearBridgeWorkerState,
  listSidecodeSessions,
  markBridgeBackfilled,
  readSidecodeSession,
  sidecodeSessionPath,
  updateBridgeSequenceNum,
  updateSidecodeSessionSelection,
  updateSidecodeSessionTitle,
  writeBridgeWorkerState,
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
    // effort is hardcoded for Desktop-schema compatibility — see
    // SidecodeSessionMetadata.effort docstring.
    expect(meta.effort).toBe("xhigh");
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

describe("buildNewSidecodeSession — model", () => {
  it("persists model when provided", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "hi",
      model: "claude-opus-4-7[1m]",
    });
    expect(meta.model).toBe("claude-opus-4-7[1m]");
  });

  it("omits model when not provided (pre-picker bootstrap case)", () => {
    const meta = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "hi",
    });
    expect(meta).not.toHaveProperty("model");
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

  it("writes model into existing metadata", () => {
    const initial = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "init",
    });
    writeSidecodeSession(home, initial);
    const result = updateSidecodeSessionSelection(home, "x", {
      model: "claude-opus-4-7[1m]",
    });
    expect(result?.model).toBe("claude-opus-4-7[1m]");
    const onDisk = readSidecodeSession(home, "x");
    expect(onDisk?.model).toBe("claude-opus-4-7[1m]");
  });

  it("preserves other fields (title / cwd / createdAt) unchanged", () => {
    const initial = buildNewSidecodeSession({
      cliSessionId: "x",
      cwd: "/p",
      firstPrompt: "Important task",
      now: 1_700_000_000_000,
    });
    writeSidecodeSession(home, initial);
    updateSidecodeSessionSelection(home, "x", { model: "m" });
    const after = readSidecodeSession(home, "x");
    expect(after?.title).toBe("Important task");
    expect(after?.cwd).toBe("/p");
    expect(after?.createdAt).toBe(1_700_000_000_000);
  });

  it("returns undefined and writes nothing when metadata doesn't exist", () => {
    const result = updateSidecodeSessionSelection(home, "ghost", {
      model: "m",
    });
    expect(result).toBeUndefined();
    expect(existsSync(sidecodeSessionPath(home, "ghost"))).toBe(false);
  });
});

describe("writeBridgeWorkerState (M3.1)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sc-bridge-write-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("merges {cseSessionId, lastSSESequenceNum, backfilled} into existing metadata", () => {
    const initial = buildNewSidecodeSession({
      cliSessionId: "u",
      cwd: "/p",
      firstPrompt: "hi",
    });
    writeSidecodeSession(home, initial);
    const result = writeBridgeWorkerState(home, "u", {
      cseSessionId: "cse_abc",
      lastSSESequenceNum: 0,
      backfilled: false,
    });
    expect(result?.bridge).toEqual({
      cseSessionId: "cse_abc",
      lastSSESequenceNum: 0,
      backfilled: false,
    });
    const onDisk = readSidecodeSession(home, "u");
    expect(onDisk?.bridge?.cseSessionId).toBe("cse_abc");
    // Other fields untouched.
    expect(onDisk?.title).toBe(initial.title);
    expect(onDisk?.cwd).toBe("/p");
  });

  it("overwrites a prior bridge state (re-attach with new cse_ + reset seq)", () => {
    const initial = buildNewSidecodeSession({
      cliSessionId: "u",
      cwd: "/p",
      firstPrompt: "hi",
    });
    writeSidecodeSession(home, {
      ...initial,
      bridge: {
        cseSessionId: "cse_old",
        lastSSESequenceNum: 42,
        backfilled: true,
      },
    });
    const result = writeBridgeWorkerState(home, "u", {
      cseSessionId: "cse_new",
      lastSSESequenceNum: 0,
      backfilled: false,
    });
    expect(result?.bridge).toEqual({
      cseSessionId: "cse_new",
      lastSSESequenceNum: 0,
      backfilled: false,
    });
  });

  it("returns undefined when metadata file is missing (programmer-bug signal, no fabrication)", () => {
    const result = writeBridgeWorkerState(home, "ghost", {
      cseSessionId: "cse_x",
      lastSSESequenceNum: 0,
      backfilled: false,
    });
    expect(result).toBeUndefined();
    expect(existsSync(sidecodeSessionPath(home, "ghost"))).toBe(false);
  });
});

describe("updateBridgeSequenceNum (M3.1 checkpoint)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sc-bridge-seq-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const seed = (cliSessionId: string, lastSSESequenceNum: number) => {
    const base = buildNewSidecodeSession({
      cliSessionId,
      cwd: "/p",
      firstPrompt: "hi",
    });
    writeSidecodeSession(home, {
      ...base,
      bridge: { cseSessionId: "cse_x", lastSSESequenceNum, backfilled: false },
    });
  };

  it("advances the seq when the new value is higher", () => {
    seed("u", 3);
    const result = updateBridgeSequenceNum(home, "u", 7);
    expect(result?.bridge?.lastSSESequenceNum).toBe(7);
    expect(readSidecodeSession(home, "u")?.bridge?.lastSSESequenceNum).toBe(7);
  });

  it("never moves backwards (stale-callback guard returns existing unchanged)", () => {
    seed("u", 10);
    const result = updateBridgeSequenceNum(home, "u", 5);
    // The current behavior returns the existing record unchanged when no
    // advance is warranted — caller can treat as a no-op success.
    expect(result?.bridge?.lastSSESequenceNum).toBe(10);
    expect(readSidecodeSession(home, "u")?.bridge?.lastSSESequenceNum).toBe(10);
  });

  it("treats equal seq as a no-op (no rewrite, no regression)", () => {
    seed("u", 5);
    updateBridgeSequenceNum(home, "u", 5);
    expect(readSidecodeSession(home, "u")?.bridge?.lastSSESequenceNum).toBe(5);
  });

  it("returns undefined when bridge field is absent (pure session, no checkpoint to advance)", () => {
    const base = buildNewSidecodeSession({
      cliSessionId: "p",
      cwd: "/p",
      firstPrompt: "hi",
    });
    writeSidecodeSession(home, base); // no bridge
    expect(updateBridgeSequenceNum(home, "p", 5)).toBeUndefined();
  });

  it("returns undefined when metadata is missing entirely", () => {
    expect(updateBridgeSequenceNum(home, "ghost", 5)).toBeUndefined();
  });
});

describe("markBridgeBackfilled (M3.3 upgrade hook)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sc-bridge-bf-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("flips backfilled false → true and persists", () => {
    const base = buildNewSidecodeSession({
      cliSessionId: "u",
      cwd: "/p",
      firstPrompt: "hi",
    });
    writeSidecodeSession(home, {
      ...base,
      bridge: {
        cseSessionId: "cse_x",
        lastSSESequenceNum: 0,
        backfilled: false,
      },
    });
    const result = markBridgeBackfilled(home, "u");
    expect(result?.bridge?.backfilled).toBe(true);
    expect(readSidecodeSession(home, "u")?.bridge?.backfilled).toBe(true);
  });

  it("is idempotent (already-backfilled stays true, returns existing)", () => {
    const base = buildNewSidecodeSession({
      cliSessionId: "u",
      cwd: "/p",
      firstPrompt: "hi",
    });
    writeSidecodeSession(home, {
      ...base,
      bridge: {
        cseSessionId: "cse_x",
        lastSSESequenceNum: 0,
        backfilled: true,
      },
    });
    const result = markBridgeBackfilled(home, "u");
    expect(result?.bridge?.backfilled).toBe(true);
  });

  it("returns undefined when bridge field is absent", () => {
    const base = buildNewSidecodeSession({
      cliSessionId: "p",
      cwd: "/p",
      firstPrompt: "hi",
    });
    writeSidecodeSession(home, base);
    expect(markBridgeBackfilled(home, "p")).toBeUndefined();
  });
});

describe("clearBridgeWorkerState (M3.1 explicit detach)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "sc-bridge-clr-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("removes the bridge field while leaving all other metadata intact", () => {
    const base = buildNewSidecodeSession({
      cliSessionId: "u",
      cwd: "/p",
      firstPrompt: "first prompt",
      now: 1_700_000_000_000,
    });
    writeSidecodeSession(home, {
      ...base,
      bridge: {
        cseSessionId: "cse_x",
        lastSSESequenceNum: 5,
        backfilled: true,
      },
    });
    const result = clearBridgeWorkerState(home, "u");
    expect(result?.bridge).toBeUndefined();
    const onDisk = readSidecodeSession(home, "u");
    expect(onDisk?.bridge).toBeUndefined();
    // Other fields preserved — proves we only stripped `bridge`.
    expect(onDisk?.title).toBe("first prompt");
    expect(onDisk?.cwd).toBe("/p");
    expect(onDisk?.createdAt).toBe(1_700_000_000_000);
  });

  it("no-op when bridge field already absent (returns existing record)", () => {
    const base = buildNewSidecodeSession({
      cliSessionId: "p",
      cwd: "/p",
      firstPrompt: "hi",
    });
    writeSidecodeSession(home, base);
    const result = clearBridgeWorkerState(home, "p");
    expect(result?.cliSessionId).toBe("p");
    expect(result?.bridge).toBeUndefined();
  });

  it("returns undefined when metadata is missing entirely", () => {
    // Use a stale closure to avoid TS complaint about undefined branch
    const result = clearBridgeWorkerState(home, "ghost");
    expect(result).toBeUndefined();
  });
});
