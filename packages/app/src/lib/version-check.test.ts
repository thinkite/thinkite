import { describe, expect, it } from "vitest";
import { isSameMajor } from "./version-check";

describe("isSameMajor", () => {
  it("same major returns true regardless of minor / patch", () => {
    expect(isSameMajor("1.0.0", "1.0.0")).toBe(true);
    expect(isSameMajor("1.0.0", "1.5.3")).toBe(true);
    expect(isSameMajor("1.2.3", "1.99.99")).toBe(true);
  });

  it("different major returns false", () => {
    expect(isSameMajor("1.0.0", "2.0.0")).toBe(false);
    expect(isSameMajor("0.5.0", "1.0.0")).toBe(false);
  });

  it("tolerates pre-release / build metadata suffixes on the patch", () => {
    // We only look at the major segment, so suffixes after the first
    // "." are ignored. `0.x` major still equals `0.x`.
    expect(isSameMajor("0.5.0-beta.1", "0.5.0")).toBe(true);
    expect(isSameMajor("1.0.0+sha.abc", "1.0.0")).toBe(true);
  });

  it("null / undefined / empty / non-numeric → mismatch (err on warn)", () => {
    // When we can't parse a major, we err on the side of warning the
    // user rather than silently masking a possibly-real mismatch.
    expect(isSameMajor(null, "1.0.0")).toBe(false);
    expect(isSameMajor("1.0.0", undefined)).toBe(false);
    expect(isSameMajor("", "1.0.0")).toBe(false);
    expect(isSameMajor("abc", "1.0.0")).toBe(false);
  });
});
