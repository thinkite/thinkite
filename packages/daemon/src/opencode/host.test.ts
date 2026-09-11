import { afterEach, describe, expect, it } from "vitest";
import {
  agentHost,
  DEFAULT_OPENCODE_MODEL,
  resolveOpencodeModel,
} from "./host.ts";

const savedHost = process.env.THINKITE_AGENT_HOST;
const savedModel = process.env.THINKITE_OPENCODE_MODEL;

afterEach(() => {
  if (savedHost === undefined) delete process.env.THINKITE_AGENT_HOST;
  else process.env.THINKITE_AGENT_HOST = savedHost;
  if (savedModel === undefined) delete process.env.THINKITE_OPENCODE_MODEL;
  else process.env.THINKITE_OPENCODE_MODEL = savedModel;
});

describe("agentHost", () => {
  it("defaults to opencode on this branch", () => {
    delete process.env.THINKITE_AGENT_HOST;
    expect(agentHost()).toBe("opencode");
  });

  it("honours the claude switch for reversibility", () => {
    process.env.THINKITE_AGENT_HOST = "claude";
    expect(agentHost()).toBe("claude");
  });
});

describe("resolveOpencodeModel", () => {
  it("splits providerID/modelID on the first slash", () => {
    expect(resolveOpencodeModel("opencode-go/deepseek-v4.1-flash")).toEqual({
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
    });
    // Model ids may themselves contain slashes.
    expect(resolveOpencodeModel("a/b/c")).toEqual({
      providerID: "a",
      id: "b/c",
    });
  });

  it("prefers the explicit model, then env, then the default", () => {
    process.env.THINKITE_OPENCODE_MODEL = "p/m";
    expect(resolveOpencodeModel("x/y")).toEqual({ providerID: "x", id: "y" });
    expect(resolveOpencodeModel(undefined)).toEqual({
      providerID: "p",
      id: "m",
    });
    delete process.env.THINKITE_OPENCODE_MODEL;
    const slash = DEFAULT_OPENCODE_MODEL.indexOf("/");
    expect(resolveOpencodeModel(undefined)).toEqual({
      providerID: DEFAULT_OPENCODE_MODEL.slice(0, slash),
      id: DEFAULT_OPENCODE_MODEL.slice(slash + 1),
    });
  });
});
