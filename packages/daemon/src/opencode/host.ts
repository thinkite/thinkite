/**
 * Process supervisor for the opencode agent host.
 *
 * Spawns `opencode serve` on demand (lazy — first opencode-hosted prompt),
 * keeps one server per daemon process, and stops it on `daemon.stop()`.
 * Also owns the single server-wide live bus (`/api/event`) that carries
 * the live-only `*.delta` fragments plus the permission/question asks the
 * daemon auto-replies to (see below).
 *
 * Credentials: the v2 runner resolves provider credentials from opencode's
 * own integration store (or `OPENCODE_API_KEY`), never from the daemon.
 * This module only passes `THINKITE_OPENCODE_API_KEY` through when set and
 * otherwise relies on the user's opencode integration state.
 *
 * Permissions (stage-1 parity with run-query's `bypassPermissions` +
 * `AskUserQuestion`-disallowed behaviour):
 *   1. Env-injected config: `OPENCODE_PERMISSION={"question":"deny",
 *      "plan_enter":"deny","plan_exit":"deny"}`. opencode merges this as
 *      user-level config (`config.ts`), which wins over the `build`
 *      agent's builtin `question:allow` via findLast (`permission/
 *      index.ts`), and `disabled()` hides the denied tools from the model
 *      — the same mechanism the official CLI uses for non-interactive
 *      `opencode run` (`cli/cmd/run.ts`: deny rules for question /
 *      plan_enter / plan_exit). The `build` agent default (`"*":"allow"`,
 *      `agent.ts`) already auto-allows everything else, so no turn ever
 *      blocks on a tool permission in the common case.
 *   2. Backstop auto-reply on the global bus: any `permission.v2.asked`
 *      that still fires (e.g. `external_directory:ask`) is answered
 *      `"once"` (mirrors `opencode run --auto`), and any
 *      `question.v2.asked` is rejected (mirrors non-interactive `run.ts`,
 *      which auto-rejects permission asks when `--auto` is off). Both are
 *      best-effort and only logged on failure.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";
import {
  OpencodeClient,
  type OpencodeLiveEvent,
  type OpencodeModelRef,
} from "./client.ts";

/** Which agent host drives turns. Default `opencode` on this branch. */
export function agentHost(): "claude" | "opencode" {
  return process.env.THINKITE_AGENT_HOST === "claude" ? "claude" : "opencode";
}

/**
 * Fallback model when neither the prompt nor the env pins one.
 * Verified cheap + working against this opencode version in the stage-1
 * spikes (same model the spikes used).
 */
export const DEFAULT_OPENCODE_MODEL = "opencode-go/deepseek-v4.1-flash";

/** Split `providerID/modelID` on the first `/` (modelIDs may contain `/`). */
export function resolveOpencodeModel(explicit?: string): OpencodeModelRef {
  const raw =
    explicit ?? process.env.THINKITE_OPENCODE_MODEL ?? DEFAULT_OPENCODE_MODEL;
  const slash = raw.indexOf("/");
  if (slash < 0) {
    const fallback = DEFAULT_OPENCODE_MODEL;
    const i = fallback.indexOf("/");
    return {
      providerID: fallback.slice(0, i),
      id: fallback.slice(i + 1),
    };
  }
  return { providerID: raw.slice(0, slash), id: raw.slice(slash + 1) };
}

/** Session ids of live-only-delta subscribers, fed from the global bus. */
export type LiveDeltaHandler = (e: OpencodeLiveEvent) => void;

const HEALTH_POLL_MS = 100;
const HEALTH_TIMEOUT_MS = 30_000;
const BUS_RECONNECT_MS = 1000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    // Bind-then-use: `--port 0` once yielded a bogus port (spike gotcha),
    // so allocate an explicit free port instead of trusting `0`.
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export class OpencodeHost {
  private child: ChildProcess | null = null;
  private client_: OpencodeClient | null = null;
  private starting: Promise<OpencodeClient> | null = null;
  private stopped = false;
  private readonly log: (msg: string) => void;

  private busAbort: AbortController | null = null;
  private readonly liveHandlers = new Map<string, LiveDeltaHandler>();

  constructor(log?: (msg: string) => void) {
    this.log = log ?? ((msg) => console.log(`[sidecode] ${msg}`));
  }

  /** Idempotent lazy start. Resolves with an authenticated client. */
  async start(): Promise<OpencodeClient> {
    if (this.client_ !== null) return this.client_;
    if (this.starting !== null) return this.starting;
    if (this.stopped) {
      throw new Error("opencode host is stopped");
    }
    this.starting = this.spawn();
    try {
      const client = await this.starting;
      this.client_ = client;
      return client;
    } finally {
      this.starting = null;
    }
  }

  get client(): OpencodeClient | null {
    return this.client_;
  }

  get running(): boolean {
    return this.child !== null;
  }

  /** Register a live-delta handler for one opencode session id. */
  onLiveDelta(
    opencodeSessionId: string,
    handler: LiveDeltaHandler,
  ): () => void {
    this.liveHandlers.set(opencodeSessionId, handler);
    return () => {
      if (this.liveHandlers.get(opencodeSessionId) === handler) {
        this.liveHandlers.delete(opencodeSessionId);
      }
    };
  }

  private async spawn(): Promise<OpencodeClient> {
    const username = "opencode";
    const password = randomBytes(16).toString("hex");
    const port = await freePort();
    const env: Record<string, string | undefined> = {
      ...process.env,
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_CLIENT: "thinkite",
      // Stage-1 parity with bypassPermissions + AskUserQuestion-disallowed
      // (see module docstring for the mechanism + source refs).
      OPENCODE_PERMISSION: JSON.stringify({
        question: "deny",
        plan_enter: "deny",
        plan_exit: "deny",
      }),
    };
    // Pass through only — never read or log the value.
    if (process.env.THINKITE_OPENCODE_API_KEY !== undefined) {
      env.OPENCODE_API_KEY = process.env.THINKITE_OPENCODE_API_KEY;
    }
    const child = spawn(
      "opencode",
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stderr?.on("data", (chunk: Buffer) => {
      this.log(`[opencode stderr] ${String(chunk).trimEnd().slice(0, 500)}`);
    });
    child.on("exit", (code, signal) => {
      this.log(
        `[opencode] server exited code=${code} signal=${signal} — next opencode prompt will respawn`,
      );
      // Clear the handle so the next `start()` respawns lazily. In-flight
      // session loops observe their stream ending and settle their turns
      // as interrupted/failed; re-prompt uses `resume: true`.
      if (this.child === child) {
        this.child = null;
        this.client_ = null;
      }
      this.stopBus();
    });

    const base = await new Promise<URL>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        reject(new Error("opencode serve did not report listening in 30s"));
      }, HEALTH_TIMEOUT_MS);
      child.stdout?.on("data", (chunk: Buffer) => {
        buf += String(chunk);
        const m = buf.match(/listening on (http:\/\/[^\s]+)/);
        if (m?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(new URL(m[1]));
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`opencode serve exited early: ${code}`));
      });
    });

    const client = new OpencodeClient(base, username, password);
    await this.waitHealthy(client);
    this.log(`[opencode] up at ${base} (pid ${child.pid})`);
    this.startBus(client);
    return client;
  }

  private async waitHealthy(client: OpencodeClient): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    for (;;) {
      if (await client.health()) return;
      if (Date.now() > deadline) {
        throw new Error("opencode server did not become healthy in 30s");
      }
      await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
    }
  }

  // ─── Global live bus ─────────────────────────────────────────────
  //
  // One subscription per daemon (not per session): routes live-only
  // `*.delta` fragments to the owning session loop by `data.sessionID`
  // and auto-replies permission/question asks. Reconnects with backoff
  // while the host lives; per-session streams do their own replay via
  // `after=` so a bus gap only costs typing-effect smoothness.

  private startBus(client: OpencodeClient): void {
    if (this.busAbort !== null || this.stopped) return;
    const abort = new AbortController();
    this.busAbort = abort;
    void this.runBus(client, abort.signal).catch((err) => {
      this.log(`[opencode] global bus ended: ${errMessage(err)}`);
    });
  }

  private stopBus(): void {
    this.busAbort?.abort();
    this.busAbort = null;
  }

  private async runBus(
    client: OpencodeClient,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted && !this.stopped) {
      try {
        const { done } = await client.subscribeGlobal(
          (e) => this.dispatchGlobal(client, e),
          signal,
        );
        await done;
      } catch (err) {
        if (signal.aborted || this.stopped) return;
        this.log(`[opencode] global bus error, retrying: ${errMessage(err)}`);
      }
      if (!signal.aborted && !this.stopped) {
        await new Promise((r) => setTimeout(r, BUS_RECONNECT_MS));
      }
    }
  }

  private dispatchGlobal(client: OpencodeClient, e: OpencodeLiveEvent): void {
    // Backstop auto-replies first (never block the bus on them).
    if (e.type === "permission.v2.asked") {
      void this.autoReplyPermission(client, e);
      return;
    }
    if (e.type === "question.v2.asked") {
      void this.autoRejectQuestion(client, e);
      return;
    }
    // Live-only fragments ride the bus with the v2 type names (spike 2:
    // durable replay carries the full value; these are typing-effect only).
    if (!e.type.endsWith(".delta")) return;
    const sessionID =
      typeof e.data.sessionID === "string" ? e.data.sessionID : undefined;
    if (sessionID === undefined) return;
    try {
      this.liveHandlers.get(sessionID)?.(e);
    } catch (err) {
      this.log(`[opencode] live handler failed: ${errMessage(err)}`);
    }
  }

  private async autoReplyPermission(
    client: OpencodeClient,
    e: OpencodeLiveEvent,
  ): Promise<void> {
    const sessionID =
      typeof e.data.sessionID === "string" ? e.data.sessionID : undefined;
    const requestID = typeof e.data.id === "string" ? e.data.id : undefined;
    if (sessionID === undefined || requestID === undefined) return;
    try {
      // "once" mirrors `opencode run --auto` (allow this step).
      await client.replyPermission(sessionID, requestID, "once");
    } catch (err) {
      this.log(`[opencode] permission auto-reply failed: ${errMessage(err)}`);
    }
  }

  private async autoRejectQuestion(
    client: OpencodeClient,
    e: OpencodeLiveEvent,
  ): Promise<void> {
    const sessionID =
      typeof e.data.sessionID === "string" ? e.data.sessionID : undefined;
    const requestID = typeof e.data.id === "string" ? e.data.id : undefined;
    if (sessionID === undefined || requestID === undefined) return;
    try {
      // The question tool is hidden from the model via the deny rule, so
      // this is a backstop only — mirrors non-interactive run.ts.
      await client.rejectQuestion(sessionID, requestID);
    } catch (err) {
      this.log(`[opencode] question auto-reject failed: ${errMessage(err)}`);
    }
  }

  /** Stop the bus + server. Idempotent; called from `daemon.stop()`. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopBus();
    const child = this.child;
    this.child = null;
    this.client_ = null;
    if (child === null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill("SIGTERM");
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
