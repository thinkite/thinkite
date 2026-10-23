import type { ModelInfo } from "@thinkite/oc-client";
import { describe, expect, it } from "vitest";
import { modelSections, newestOfFamilies } from "./model-catalog";

const NOW = Date.UTC(2026, 9, 22);
const DAY = 24 * 60 * 60 * 1000;

const model = (
  providerID: string,
  id: string,
  extra: Partial<ModelInfo> = {},
): ModelInfo =>
  ({
    id,
    modelID: id,
    providerID,
    name: id,
    variants: [],
    cost: [{ input: 1 }],
    time: { released: NOW - 10 * DAY },
    enabled: true,
    status: "active",
    limit: { context: 200_000, output: 8_000 },
    ...extra,
  }) as unknown as ModelInfo;

const providers = new Map([
  ["anthropic", "Anthropic"],
  ["zai", "Z.AI"],
  ["opencode", "OpenCode Zen"],
]);

describe("newestOfFamilies", () => {
  it("keeps the newest of a family, and nothing older than six months", () => {
    const refs = newestOfFamilies(
      [
        model("anthropic", "a-1", {
          family: "a",
          time: { released: NOW - 50 * DAY },
        }),
        model("anthropic", "a-2", {
          family: "a",
          time: { released: NOW - 5 * DAY },
        }),
        model("anthropic", "old", { time: { released: NOW - 400 * DAY } }),
      ],
      NOW,
    );
    expect([...refs]).toEqual(["anthropic/a-2"]);
  });
});

describe("modelSections", () => {
  const models = [
    model("zai", "glm-5"),
    model("anthropic", "sonnet", {
      family: "claude",
      time: { released: NOW - 50 * DAY },
    }),
    model("anthropic", "opus", {
      family: "claude",
      time: { released: NOW - 5 * DAY },
    }),
    model("opencode", "big-pickle", {
      cost: [{ input: 0 }],
    } as Partial<ModelInfo>),
  ];

  it("orders providers like opencode desktop, then by name", () => {
    const sections = modelSections(models, providers, null, "", NOW);
    expect(sections.map((s) => s.title)).toEqual([
      "OpenCode Zen",
      "Anthropic",
      "Z.AI",
    ]);
  });

  it("shows the newest of a family, and the current model whatever its age", () => {
    const plain = modelSections(models, providers, null, "", NOW);
    expect(plain[1]?.models.map((m) => m.id)).toEqual(["opus"]);
    const withCurrent = modelSections(
      models,
      providers,
      "anthropic/sonnet",
      "",
      NOW,
    );
    expect(withCurrent[1]?.models.map((m) => m.id)).toEqual(["opus", "sonnet"]);
  });

  it("searches past the syllable breaks of a pinyin keyboard", () => {
    expect(
      modelSections(models, providers, null, "o pu s", NOW).flatMap((s) =>
        s.models.map((m) => m.id),
      ),
    ).toEqual(["opus"]);
  });

  it("searches every model by name or provider", () => {
    expect(
      modelSections(models, providers, null, "SON", NOW).flatMap((s) =>
        s.models.map((m) => m.id),
      ),
    ).toEqual(["sonnet"]);
    expect(
      modelSections(models, providers, null, "anthropic", NOW).flatMap((s) =>
        s.models.map((m) => m.id),
      ),
    ).toEqual(["opus", "sonnet"]);
  });
});
