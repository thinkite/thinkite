import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSidecodeHome } from "./home.ts";

describe("resolveSidecodeHome", () => {
  let originalEnv: string | undefined;
  let tmpRoot: string;

  beforeEach(() => {
    originalEnv = process.env.SIDECODE_HOME;
    delete process.env.SIDECODE_HOME;
    tmpRoot = mkdtempSync(join(tmpdir(), "sidecode-home-test-"));
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.SIDECODE_HOME;
    else process.env.SIDECODE_HOME = originalEnv;
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("uses $SIDECODE_HOME when set", () => {
    const target = join(tmpRoot, "custom");
    process.env.SIDECODE_HOME = target;
    expect(resolveSidecodeHome()).toBe(target);
  });

  it("creates directory with 0700 permissions", () => {
    const target = join(tmpRoot, "perm-test");
    process.env.SIDECODE_HOME = target;
    resolveSidecodeHome();
    expect(statSync(target).mode & 0o777).toBe(0o700);
  });

  it("is idempotent on an existing dir", () => {
    const target = join(tmpRoot, "idem");
    process.env.SIDECODE_HOME = target;
    expect(resolveSidecodeHome()).toBe(target);
    expect(resolveSidecodeHome()).toBe(target);
  });

  it("uses homeDirOverride/.sidecode when env unset", () => {
    const result = resolveSidecodeHome(tmpRoot);
    expect(result).toBe(join(tmpRoot, ".sidecode"));
    expect(statSync(result).isDirectory()).toBe(true);
  });

  it("throws if path exists but is a file", () => {
    const target = join(tmpRoot, "iam-a-file");
    writeFileSync(target, "x");
    process.env.SIDECODE_HOME = target;
    expect(() => resolveSidecodeHome()).toThrow(/not a directory/);
  });
});
