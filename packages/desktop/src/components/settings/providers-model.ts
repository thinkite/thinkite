import type { IntegrationInfo } from "@thinkite/oc-client";

// What Settings › Providers shows, worked out from the service's integration
// list the way opencode desktop does (`settings/providers/providers.tsx`,
// `providers/connect/controller.ts` at v2.1.2, MIT). Kept apart from the
// view so it can be tested on plain data.

export type Method = IntegrationInfo["methods"][number];
/** A way to connect that the dialog can run (not env, not command). */
export type UsableMethod = Extract<
  Method,
  { type: "key" | "oauth" | "external" }
>;
type Connection = IntegrationInfo["connections"][number];
export type Account = Extract<Connection, { type: "credential" }>;

/** opencode desktop's popular providers, in its order. */
export const POPULAR = [
  "opencode-go",
  "opencode",
  "anthropic",
  "github-copilot",
  "openai",
  "google",
  "openrouter",
  "vercel",
];

const RECOMMENDED = new Set(["opencode", "opencode-go"]);
export const isRecommended = (id: string) => RECOMMENDED.has(id);

/**
 * The methods the dialog offers, in the service's order. A provider with
 * none (only env vars, or a command) still takes an API key, as opencode's
 * dialog falls back to one.
 */
export function usableMethods(integration: IntegrationInfo): UsableMethod[] {
  const usable = integration.methods.filter(
    (m): m is UsableMethod =>
      m.type === "key" || m.type === "oauth" || m.type === "external",
  );
  return usable.length > 0 ? usable : [{ type: "key" }];
}

/** Stored accounts; the service lists the active one first. */
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
  if (first.method === "oauth") return "Account";
  if (first.method === "key") return "API key";
  return "External";
}

const byName = (a: IntegrationInfo, b: IntegrationInfo) =>
  a.name.localeCompare(b.name);

/** Connected providers: OpenCode Go first, then by name. */
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

/** Popular providers not connected yet, in opencode's order. */
export function popularOf(all: readonly IntegrationInfo[]): IntegrationInfo[] {
  const byId = new Map(all.map((i) => [i.id, i]));
  return POPULAR.flatMap((id) => {
    const integration = byId.get(id);
    return integration && !isConnected(integration) ? [integration] : [];
  });
}

/** The connect dialog's picker: popular first in their order, the rest by
 *  name; `query` matches names and ids. */
export function pickerGroups(
  all: readonly IntegrationInfo[],
  query: string,
): { popular: IntegrationInfo[]; other: IntegrationInfo[] } {
  const q = query.trim().toLowerCase();
  const matches = all.filter(
    (i) =>
      q === "" ||
      i.name.toLowerCase().includes(q) ||
      i.id.toLowerCase().includes(q),
  );
  const popular = POPULAR.flatMap((id) => matches.filter((i) => i.id === id));
  const other = matches.filter((i) => !POPULAR.includes(i.id)).sort(byName);
  return { popular, other };
}

/**
 * The code a device sign-in asks the user to confirm: the URL's
 * `user_code`, else whatever follows the last ":" of the instructions.
 */
export function confirmationCode(
  url: string,
  instructions: string,
): string | null {
  try {
    const code = new URL(url).searchParams.get("user_code");
    if (code) return code;
  } catch {
    // Not a URL; try the instructions.
  }
  const colon = instructions.lastIndexOf(":");
  const tail = colon >= 0 ? instructions.slice(colon + 1).trim() : "";
  return /^[A-Z0-9][A-Z0-9-]{3,}$/i.test(tail) ? tail : null;
}
