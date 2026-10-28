import { describe, expect, it } from "vitest";
import { isPluginSpec, summarizeCliError } from "./plugins.ts";

describe("isPluginSpec", () => {
  it("accepts npm and git specifiers", () => {
    expect(isPluginSpec("@cc-mem/opencode")).toBe(true);
    expect(isPluginSpec("opencode-foo@1.2.3")).toBe(true);
    expect(isPluginSpec("github:owner/repo")).toBe(true);
  });

  it("rejects what the CLI would read as a flag or more than one argument", () => {
    expect(isPluginSpec("")).toBe(false);
    expect(isPluginSpec("--help")).toBe(false);
    expect(isPluginSpec("-x")).toBe(false);
    expect(isPluginSpec("a b")).toBe(false);
    expect(isPluginSpec("a".repeat(513))).toBe(false);
  });
});

describe("summarizeCliError", () => {
  it("returns the error's message", () => {
    expect(
      summarizeCliError(
        [
          "Error: Plugin target must be an npm registry package or Git package specifier",
          "    at <anonymous> (/$bunfs/root/chunk.js:2:1345)",
        ].join("\n"),
      ),
    ).toBe(
      "Plugin target must be an npm registry package or Git package specifier",
    );
  });

  it("says an npm 404 is a missing package", () => {
    expect(
      summarizeCliError(
        [
          "NpmInstallFailedError: ",
          "    at catch (/$bunfs/root/chunk.js:2:4259)",
          "  [cause]: r_: 404 Not Found - GET https://registry.npmjs.org/@x%2fy - Not found",
          "      at <anonymous> (/$bunfs/root/chunk.js:32:1158)",
          "}",
        ].join("\n"),
      ),
    ).toBe("No such package on npm");
  });

  it("falls back to the cause when the message is empty", () => {
    expect(
      summarizeCliError(
        [
          "NpmInstallFailedError: ",
          "  [cause]: r_: getaddrinfo ENOTFOUND registry.npmjs.org",
        ].join("\n"),
      ),
    ).toBe("getaddrinfo ENOTFOUND registry.npmjs.org");
  });

  it("has a message for empty output", () => {
    expect(summarizeCliError("")).toBe("opencode exited with an error");
  });
});
