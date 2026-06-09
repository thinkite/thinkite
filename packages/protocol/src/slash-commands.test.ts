import { describe, expect, it } from "vitest";
import {
  getCommandsForContext,
  isWhitelistedCommand,
  parseSlashCommand,
  SLASH_COMMANDS,
} from "./slash-commands.ts";

describe("SLASH_COMMANDS table invariants", () => {
  it("every spec.name matches its map key", () => {
    for (const [key, spec] of Object.entries(SLASH_COMMANDS)) {
      expect(spec.name).toBe(key);
    }
  });

  it("every spec has at least one context", () => {
    for (const spec of Object.values(SLASH_COMMANDS)) {
      expect(spec.contexts.length).toBeGreaterThan(0);
    }
  });

  it("V0 intercept-handling commands are the expected pair", () => {
    // Catches accidental flips between intercept/passthrough. If you
    // intentionally move a command between buckets, update this set.
    const interceptNames = Object.values(SLASH_COMMANDS)
      .filter((s) => s.handling === "intercept")
      .map((s) => s.name)
      .sort();
    expect(interceptNames).toEqual(["clear", "model"]);
  });

  it("V0 passthrough-handling commands are the expected trio", () => {
    const passthroughNames = Object.values(SLASH_COMMANDS)
      .filter((s) => s.handling === "passthrough")
      .map((s) => s.name)
      .sort();
    expect(passthroughNames).toEqual(["compact", "init", "review"]);
  });
});

describe("isWhitelistedCommand", () => {
  it("accepts known commands", () => {
    expect(isWhitelistedCommand("init")).toBe(true);
    expect(isWhitelistedCommand("model")).toBe(true);
  });

  it("rejects unknown commands", () => {
    expect(isWhitelistedCommand("fork")).toBe(false);
    expect(isWhitelistedCommand("shrug")).toBe(false);
    expect(isWhitelistedCommand("")).toBe(false);
  });

  it("is case-sensitive (Claude Code is)", () => {
    expect(isWhitelistedCommand("Init")).toBe(false);
    expect(isWhitelistedCommand("MODEL")).toBe(false);
  });

  it("does NOT trip on inherited Object.prototype names", () => {
    // Guard against `'toString' in SLASH_COMMANDS` returning true via
    // the prototype chain. We use hasOwnProperty for this reason.
    expect(isWhitelistedCommand("toString")).toBe(false);
    expect(isWhitelistedCommand("constructor")).toBe(false);
    expect(isWhitelistedCommand("hasOwnProperty")).toBe(false);
  });
});

describe("getCommandsForContext", () => {
  it("new-session returns only commands flagged for new-session", () => {
    const names = getCommandsForContext("new-session").map((c) => c.name);
    expect(names).toEqual(["init", "review"]);
  });

  it("in-session returns all five V0 commands", () => {
    const names = getCommandsForContext("in-session").map((c) => c.name);
    expect(names).toEqual(["init", "review", "clear", "compact", "model"]);
  });

  it("preserves SLASH_COMMANDS declaration order", () => {
    // Picker UX depends on this — prompts first, then mutators.
    const all = getCommandsForContext("in-session");
    expect(all[0]?.name).toBe("init");
    expect(all[all.length - 1]?.name).toBe("model");
  });
});

describe("parseSlashCommand", () => {
  it("parses a bare command with no args", () => {
    expect(parseSlashCommand("/init")).toEqual({ name: "init", args: "" });
  });

  it("parses a command with one positional arg", () => {
    expect(parseSlashCommand("/model claude-opus-4-7")).toEqual({
      name: "model",
      args: "claude-opus-4-7",
    });
  });

  it("joins multiple positional args back with single spaces", () => {
    expect(parseSlashCommand("/review 123 abc def")).toEqual({
      name: "review",
      args: "123 abc def",
    });
  });

  it("trims leading and trailing whitespace before parsing", () => {
    expect(parseSlashCommand("  /init  ")).toEqual({ name: "init", args: "" });
    expect(parseSlashCommand("/model claude-opus-4-7  ")).toEqual({
      name: "model",
      args: "claude-opus-4-7",
    });
  });

  it("returns null for input without leading slash", () => {
    expect(parseSlashCommand("hello")).toBeNull();
    expect(parseSlashCommand("hello /model x")).toBeNull();
  });

  it("returns null for bare slash or whitespace-only after slash", () => {
    expect(parseSlashCommand("/")).toBeNull();
    expect(parseSlashCommand("/ ")).toBeNull();
    expect(parseSlashCommand(" / ")).toBeNull();
  });

  it("treats `/ foo` (space immediately after slash) as null", () => {
    // Conservative: a trailing space after `/` means empty command name,
    // which is meaningless. Matches Claude Code's parser behavior.
    expect(parseSlashCommand("/ foo")).toBeNull();
  });

  it("preserves args case (model ids are case-sensitive)", () => {
    expect(parseSlashCommand("/model Claude-Opus-4-7")?.args).toBe(
      "Claude-Opus-4-7",
    );
  });
});
