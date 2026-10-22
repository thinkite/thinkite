import type { IntegrationInfo } from "@thinkite/oc-client";
import { describe, expect, it } from "vitest";
import {
  accountsOf,
  confirmationCode,
  connectedOf,
  pickerGroups,
  popularOf,
  sourceLabel,
  usableMethods,
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
  it("offers key, oauth and external methods, and a key when there are none", () => {
    const openai = integration("openai", "OpenAI", {
      methods: [
        { type: "key" },
        { type: "env", names: ["OPENAI_API_KEY"] },
        { id: "chatgpt", type: "oauth", label: "Sign in with ChatGPT" },
      ],
    });
    expect(usableMethods(openai).map((m) => m.type)).toEqual(["key", "oauth"]);
    const envOnly = integration("copilot", "Copilot", {
      methods: [{ type: "env", names: ["GITHUB_TOKEN"] }],
    });
    expect(usableMethods(envOnly)).toEqual([{ type: "key" }]);
  });

  it("lists connected providers Go first, and popular ones not connected", () => {
    const all = [
      integration("anthropic", "Anthropic"),
      integration("deepseek", "DeepSeek", {
        connections: [key("cred_d", "DeepSeek")],
      }),
      integration("opencode-go", "OpenCode Go", {
        connections: [key("cred_g", "Go")],
      }),
      integration("openai", "OpenAI", {
        connections: [{ type: "env", name: "OPENAI_API_KEY" }],
      }),
      integration("opencode", "OpenCode Console"),
    ];
    expect(connectedOf(all).map((i) => i.id)).toEqual([
      "opencode-go",
      "deepseek",
      "openai",
    ]);
    expect(popularOf(all).map((i) => i.id)).toEqual(["opencode", "anthropic"]);
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
        integration("x", "X", {
          connections: [{ type: "env", name: "X_API_KEY" }],
        }),
      ),
    ).toBe("Environment");
  });

  it("groups the picker and filters it by name or id", () => {
    const all = [
      integration("zai", "Z.AI"),
      integration("openai", "OpenAI"),
      integration("anthropic", "Anthropic"),
      integration("302ai", "302.AI"),
    ];
    const { popular, other } = pickerGroups(all, "");
    expect(popular.map((i) => i.id)).toEqual(["anthropic", "openai"]);
    expect(other.map((i) => i.id)).toEqual(["302ai", "zai"]);
    expect(pickerGroups(all, "z.a").other.map((i) => i.id)).toEqual(["zai"]);
    expect(pickerGroups(all, "OPEN").popular.map((i) => i.id)).toEqual([
      "openai",
    ]);
  });

  it("finds the code a device sign-in asks to confirm", () => {
    expect(
      confirmationCode(
        "https://github.com/login/device?user_code=AB12-CD34",
        "",
      ),
    ).toBe("AB12-CD34");
    expect(
      confirmationCode(
        "https://github.com/login/device",
        "Enter code: WXYZ-1234",
      ),
    ).toBe("WXYZ-1234");
    expect(
      confirmationCode("https://poe.com/oauth/authorize", "Sign in to Poe."),
    ).toBeNull();
  });
});
