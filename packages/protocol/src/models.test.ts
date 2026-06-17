import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL,
  getDefaultModelId,
  MODEL_METADATA,
  MODELS,
  prettyModel,
} from "./models.ts";

describe("MODEL_METADATA / MODELS table", () => {
  it("has exactly one default and it is non-deprecated", () => {
    const defaults = Object.entries(MODEL_METADATA).filter(
      ([, m]) => m.isDefault === true,
    );
    expect(defaults).toHaveLength(1);
    expect(defaults[0][1].deprecated).not.toBe(true);
  });

  it("defaults to bare Opus 4.8 at 1M context (no [1m] suffix)", () => {
    expect(DEFAULT_MODEL.model).toBe("claude-opus-4-8");
    expect(getDefaultModelId()).toBe("claude-opus-4-8");
    expect(DEFAULT_MODEL.contextWindow).toBe(1_000_000);
  });

  it("carries no legacy [1m] keys — the suffix is dropped from the table", () => {
    for (const key of Object.keys(MODEL_METADATA)) {
      expect(key.endsWith("[1m]")).toBe(false);
    }
  });

  it("does not surface a 1M Sonnet variant in the picker", () => {
    // Sonnet 1M is gated behind extra-usage billing; never offered.
    expect(MODEL_METADATA["claude-sonnet-4-6"]?.contextWindow).toBe(200_000);
    expect(MODELS.some((m) => m.model.startsWith("claude-sonnet-4-6["))).toBe(
      false,
    );
  });

  it("only exposes non-deprecated entries through MODELS", () => {
    expect(MODELS.length).toBeGreaterThan(0);
    for (const m of MODELS) {
      expect(MODEL_METADATA[m.model]?.deprecated).not.toBe(true);
    }
  });
});

describe("prettyModel", () => {
  it("maps a known id to its display name", () => {
    expect(prettyModel("claude-opus-4-8")).toBe("Opus 4.8");
    expect(prettyModel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
  });

  it("normalizes a legacy [1m] id to its bare entry's label", () => {
    // Older sidecode builds persisted `…[1m]`; render via the bare entry
    // instead of regressing to a raw-string label.
    expect(prettyModel("claude-opus-4-8[1m]")).toBe("Opus 4.8");
    expect(prettyModel("claude-opus-4-7[1m]")).toBe("Opus 4.7");
  });

  it("falls through to the raw string for unknown ids", () => {
    expect(prettyModel("claude-future-9-9")).toBe("claude-future-9-9");
    expect(prettyModel("claude-future-9-9[1m]")).toBe("claude-future-9-9[1m]");
  });

  it("returns empty string for empty input", () => {
    expect(prettyModel("")).toBe("");
  });
});
