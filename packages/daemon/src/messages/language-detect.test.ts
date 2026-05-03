import { describe, expect, it } from "vitest";
import { detectLanguageForPath } from "./language-detect.js";

describe("detectLanguageForPath", () => {
  it("returns the tree-sitter lang for known extensions", () => {
    expect(detectLanguageForPath("foo.ts")).toBe("typescript");
    expect(detectLanguageForPath("foo.tsx")).toBe("tsx");
    expect(detectLanguageForPath("foo.py")).toBe("python");
    expect(detectLanguageForPath("foo.swift")).toBe("swift");
    expect(detectLanguageForPath("foo.rs")).toBe("rust");
    expect(detectLanguageForPath("foo.json")).toBe("json");
    expect(detectLanguageForPath("foo.yaml")).toBe("yaml");
    expect(detectLanguageForPath("foo.sh")).toBe("bash");
  });

  it("normalizes case + handles aliases (jsx → javascript, hpp → cpp)", () => {
    expect(detectLanguageForPath("foo.JSX")).toBe("javascript");
    expect(detectLanguageForPath("foo.cjs")).toBe("javascript");
    expect(detectLanguageForPath("vec.hpp")).toBe("cpp");
    expect(detectLanguageForPath("util.cc")).toBe("cpp");
  });

  it("only looks at the LAST extension", () => {
    expect(detectLanguageForPath("/abs/path/to/component.test.tsx")).toBe(
      "tsx",
    );
    expect(detectLanguageForPath("/abs/path/to/foo.spec.ts")).toBe("typescript");
  });

  it("matches well-known extensionless filenames", () => {
    expect(detectLanguageForPath("/abs/path/Dockerfile")).toBe("bash");
    expect(detectLanguageForPath("Makefile")).toBe("bash");
    expect(detectLanguageForPath("packages/x/Gemfile")).toBe("ruby");
  });

  it("returns undefined for unknown extensions and trailing-dot paths", () => {
    expect(detectLanguageForPath("foo.unknown")).toBeUndefined();
    expect(detectLanguageForPath("LICENSE")).toBeUndefined();
    expect(detectLanguageForPath("trailing.")).toBeUndefined();
    expect(detectLanguageForPath("nodot")).toBeUndefined();
  });
});
