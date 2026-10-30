import type { IntegrationInfo } from "@thinkite/oc-client";

// What Settings › Providers shows, worked out from the service's integration
// list. The page works like DeepSeek Harness's Models settings — pick a
// provider, paste its API key — with opencode desktop's provider order
// (`settings/providers/providers.tsx` at v2.1.2, MIT). Kept apart from the
// view so it can be tested on plain data.

type Method = IntegrationInfo["methods"][number];
export type KeyMethod = Extract<Method, { type: "key" }>;
type ExternalMethod = Extract<Method, { type: "external" }>;
type Connection = IntegrationInfo["connections"][number];
export type Account = Extract<Connection, { type: "credential" }>;

/** opencode desktop's popular providers, in its order. */
export const POPULAR = [
  "opencode-go",
  "opencode",
  "anthropic",
  "claude-agent",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
];

/** How the provider takes an API key: its own key method (some ask for an
 *  account name or URL beside the key), or a plain key when it lists none. */
export function keyMethod(integration: IntegrationInfo): KeyMethod {
  return (
    integration.methods.find((m): m is KeyMethod => m.type === "key") ?? {
      type: "key",
    }
  );
}

/** The login outside opencode the provider uses instead of an API key, as
 *  Claude Agent uses Claude Code's; null for a provider that takes a key. */
export function externalMethod(
  integration: IntegrationInfo,
): ExternalMethod | null {
  if (integration.methods.some((m) => m.type === "key")) return null;
  return (
    integration.methods.find(
      (m): m is ExternalMethod => m.type === "external",
    ) ?? null
  );
}

/** What the service's latest check of the active login found wrong. */
export function loginProblem(integration: IntegrationInfo): string | null {
  return integration.connections[0]?.status?.message ?? null;
}

/** Environment variables the service reads the provider's key from. */
export function envNames(integration: IntegrationInfo): string[] {
  return integration.methods.flatMap((m) => (m.type === "env" ? m.names : []));
}

/** The environment variable the service found the key in, if any. */
export function envDetected(integration: IntegrationInfo): string | null {
  const env = integration.connections.find((c) => c.type === "env");
  return env?.type === "env" ? env.name : null;
}

/** Stored credentials; the service lists the active one first. */
export function accountsOf(integration: IntegrationInfo): Account[] {
  return integration.connections.filter(
    (c): c is Account => c.type === "credential",
  );
}

export function isConnected(integration: IntegrationInfo): boolean {
  return integration.connections.length > 0;
}

/** How a connected provider is connected, as a short badge. */
export function sourceLabel(integration: IntegrationInfo): string {
  const first = integration.connections[0];
  if (first === undefined) return "Config";
  if (first.type === "env") return "Environment";
  if (first.method === "oauth") return "Signed in";
  if (first.method === "key") return "API key";
  return "External";
}

const byName = (a: IntegrationInfo, b: IntegrationInfo) =>
  a.name.localeCompare(b.name);

const popularRank = (id: string) => {
  const index = POPULAR.indexOf(id);
  return index < 0 ? POPULAR.length : index;
};

/** Configured providers: OpenCode Go first, then by name. */
export function connectedOf(
  all: readonly IntegrationInfo[],
): IntegrationInfo[] {
  return all
    .filter(isConnected)
    .sort(
      (a, b) =>
        Number(b.id === "opencode-go") - Number(a.id === "opencode-go") ||
        byName(a, b),
    );
}

/** Providers that can still be added: the popular ones first in opencode's
 *  order, then the rest by name. */
export function addableOf(all: readonly IntegrationInfo[]): IntegrationInfo[] {
  return all
    .filter((i) => !isConnected(i))
    .sort((a, b) => popularRank(a.id) - popularRank(b.id) || byName(a, b));
}
