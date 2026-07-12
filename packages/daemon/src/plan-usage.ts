/**
 * Plan-utilization fetcher for the menubar's "Claude Plan Usage" section.
 *
 * Data source: `GET https://api.anthropic.com/api/oauth/usage` — the same
 * undocumented-but-de-facto-stable endpoint Claude Code's own `/status`
 * command (and CodexBar / ccusage / claude-monitor) read. It reports
 * QUOTA UTILIZATION (what % of the 5h / weekly windows is consumed right
 * now + reset times) — a different metric from cumulative token stats.
 *
 * Auth rides the existing OAuthRefreshManager: `ensureFresh()` yields the
 * keychain access token (refreshing if needed), so this module never
 * touches credential storage itself and the token never crosses the
 * daemon boundary — the menubar gets parsed numbers, not a Bearer.
 *
 * Failure surface is a closed result union (never throws): the menu
 * renders each state directly — `signed_out` → "run claude /login" row,
 * `error` → keep last-good / show unavailable.
 */
import {
  OAuthRefreshError,
  type OAuthRefreshManager,
} from "./bridge/oauth-refresh.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
// REQUIRED beta cohort header — without it the endpoint 4xxes. Anthropic
// has rolled the value at least once (claude-code#13770); if calls start
// failing with 4xx, check the current claude-code CLI source for the
// live value.
const ANTHROPIC_BETA = "oauth-2025-04-20";
// Client identity matching the bundled SDK's CLI lineage (2.1.x). Not
// enforced today; third-party readers all send it as defensive cover.
const USER_AGENT = "claude-code/2.1.170";

// The endpoint is rate-limited (claude-code#31021) and the menu can be
// flapped open repeatedly — serve from cache within this window.
const CACHE_TTL_MS = 30_000;

/** One rate window (5h / 7d / per-model). Absent upstream fields stay
 *  undefined — enterprise/org accounts return partial data; treat as
 *  "unavailable", never as 0%. */
export interface PlanUsageWindow {
  /** Percentage of the window's quota consumed, 0..100 — passed through
   *  as the endpoint returns it (verified live 2026-06-11: `71`, not
   *  `0.71`). Render with `Math.round(x)%`, never multiply by 100. */
  utilization: number;
  /** ISO-8601 next reset, when the endpoint provides it. */
  resetsAt?: string;
}

export interface PlanUsage {
  fiveHour?: PlanUsageWindow;
  sevenDay?: PlanUsageWindow;
  sevenDayOpus?: PlanUsageWindow;
  sevenDaySonnet?: PlanUsageWindow;
  /** Epoch ms when this snapshot was fetched (drives menu staleness). */
  fetchedAt: number;
}

export type PlanUsageResult =
  /** Fresh (or ≤TTL-cached) snapshot. */
  | { status: "ok"; usage: PlanUsage }
  /** No usable credentials — user needs `claude /login` on this Mac. */
  | { status: "signed_out" }
  /** Transient failure (network / 403 / 429 / 5xx). Caller decides
   *  whether to keep showing a previous snapshot. */
  | { status: "error"; message: string };

/** Parse the endpoint's response body. Exported for tests. */
export function parsePlanUsage(body: unknown, fetchedAt: number): PlanUsage {
  const root = (body ?? {}) as Record<string, unknown>;
  const window = (key: string): PlanUsageWindow | undefined => {
    const w = root[key] as Record<string, unknown> | undefined;
    if (w == null || typeof w.utilization !== "number") return undefined;
    return {
      utilization: w.utilization,
      resetsAt: typeof w.resets_at === "string" ? w.resets_at : undefined,
    };
  };
  return {
    fiveHour: window("five_hour"),
    sevenDay: window("seven_day"),
    sevenDayOpus: window("seven_day_opus"),
    sevenDaySonnet: window("seven_day_sonnet"),
    fetchedAt,
  };
}

export interface PlanUsageFetcherOptions {
  /** `fetch` impl (test seam). Default = global fetch. */
  fetchImpl?: typeof fetch;
  /** Clock (test seam). Default = Date.now. */
  now?: () => number;
}

/**
 * Build the daemon-surface `fetchPlanUsage()` closure. Single-flight +
 * TTL cache: concurrent menu opens share one request, and repeat opens
 * within the TTL don't hit the endpoint at all.
 */
export function createPlanUsageFetcher(
  oauth: OAuthRefreshManager,
  options: PlanUsageFetcherOptions = {},
): () => Promise<PlanUsageResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let lastOk: PlanUsage | null = null;
  let inFlight: Promise<PlanUsageResult> | null = null;

  const fetchOnce = async (): Promise<PlanUsageResult> => {
    let token: string;
    try {
      token = await oauth.ensureFresh();
    } catch (err) {
      if (err instanceof OAuthRefreshError && err.kind !== "network") {
        return { status: "signed_out" };
      }
      return {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    let res: Response;
    try {
      res = await fetchImpl(USAGE_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
          "anthropic-beta": ANTHROPIC_BETA,
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      });
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 401 = the token itself is rejected (ensureFresh thought it was fine
    // but the server disagrees) — actionable by re-login, same as having
    // no credentials.
    if (res.status === 401) return { status: "signed_out" };
    if (!res.ok) {
      return { status: "error", message: `usage endpoint HTTP ${res.status}` };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { status: "error", message: "usage endpoint returned non-JSON" };
    }
    const usage = parsePlanUsage(body, now());
    lastOk = usage;
    return { status: "ok", usage };
  };

  return () => {
    if (lastOk && now() - lastOk.fetchedAt < CACHE_TTL_MS) {
      return Promise.resolve({ status: "ok", usage: lastOk });
    }
    if (inFlight) return inFlight;
    inFlight = fetchOnce().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
