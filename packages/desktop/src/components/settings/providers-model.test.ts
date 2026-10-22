import type { IntegrationInfo } from "@thinkite/oc-client";
import { describe, expect, it } from "vitest";
import {
  accountsOf,
  addableOf,
  connectedOf,
  envDetected,
  envNames,
  keyMethod,
  sourceLabel,
} from "./providers-model";

const integration = (
  id: string,
  name: string,
  extra: Partial<IntegrationInfo> = {},
): IntegrationInfo => ({
  id,
  name,
  methods: [{ type: "key" }, { type: "env", names: [] }],
  connections: [],
  ...extra,
});

const key = (id: string, label: string) =>
  ({ type: "credential", id, label, method: "key" }) as const;

describe("providers model", () => {
  it("takes the provider's own key method, or a plain key", () => {
    const snowflake = integration("snowflake-cortex", "Snowflake", {
      methods: [
        {
          type: "key",
          label: "Paste PAT or bearer token",
          form: [{ key: "account", type: "string", title: "Account" }],
        },
        { type: "env", names: ["SNOWFLAKE_CORTEX_TOKEN"] },
      ],
    });
    expect(keyMethod(snowflake).label).toBe("Paste PAT or bearer token");
    const envOnly = integration("copilot", "Copilot", {
      methods: [{ type: "env", names: ["GITHUB_TOKEN"] }],
    });
    expect(keyMethod(envOnly)).toEqual({ type: "key" });
    expect(envNames(envOnly)).toEqual(["GITHUB_TOKEN"]);
  });

  it("knows when the key comes from the environment", () => {
    const openai = integration("openai", "OpenAI", {
      methods: [{ type: "key" }, { type: "env", names: ["OPENAI_API_KEY"] }],
      connections: [{ type: "env", name: "OPENAI_API_KEY" }],
    });
    expect(envDetected(openai)).toBe("OPENAI_API_KEY");
    expect(sourceLabel(openai)).toBe("Environment");
    expect(envDetected(integration("x", "X"))).toBeNull();
  });

  it("lists configured providers Go first, and the rest popular first", () => {
    const all = [
      integration("zai", "Z.AI"),
      integration("anthropic", "Anthropic"),
      integration("deepseek", "DeepSeek", {
        connections: [key("cred_d", "DeepSeek")],
      }),
      integration("opencode-go", "OpenCode Go", {
        connections: [key("cred_g", "Go")],
      }),
      integration("302ai", "302.AI"),
      integration("opencode", "OpenCode Console"),
    ];
    expect(connectedOf(all).map((i) => i.id)).toEqual([
      "opencode-go",
      "deepseek",
    ]);
    expect(addableOf(all).map((i) => i.id)).toEqual([
      "opencode",
      "anthropic",
      "302ai",
      "zai",
    ]);
  });

  it("names how a provider is connected and keeps the active account first", () => {
    const accounts = [
      key("cred_work", "Work"),
      { ...key("cred_home", "Home"), method: "oauth" as const },
    ];
    const openai = integration("openai", "OpenAI", { connections: accounts });
    expect(sourceLabel(openai)).toBe("API key");
    expect(accountsOf(openai).map((a) => a.label)).toEqual(["Work", "Home"]);
    expect(
      sourceLabel(
        integration("o", "O", { connections: [accounts[1] as never] }),
      ),
    ).toBe("Signed in");
  });
});
