/**
 * Framework-agnostic opencode v2 client for Thinkite frontends.
 *
 * Thin wrapper over the published `@opencode-ai/sdk` (pinned to 1.18.30 in
 * `package.json`, in lockstep with the opencode binary version the daemon
 * spawns) `v2/client` entry — `createOpencodeClient({ baseUrl, fetch?,
 * headers? })` — plus the few helpers the UI needs: a session event stream
 * with `after=` resume and the shared global bus, both as abortable async
 * iterables.
 *
 * Runtime constraints (stage 3 reuses this on Hermes under Expo 57): no
 * `node:*` imports, no DOM-only globals beyond what Expo provides
 * (`fetch`, `ReadableStream`, `TextDecoderStream`), no `Buffer`. Only the
 * SDK (which itself only needs `fetch` + streaming bodies) is imported.
 */

import {
  createOpencodeClient,
  type OpencodeClient as SdkClient,
} from "@opencode-ai/sdk/v2/client";
import type {
  AgentV2Info,
  ModelRef,
  ModelV2Info,
  PermissionV2Reply,
  ProviderV2Info,
  QuestionV2Reply,
  SessionDurableEvent,
  SessionInputAdmitted,
  SessionV2Info,
  V2Event,
} from "@opencode-ai/sdk/v2/types";

export type {
  AgentV2Info,
  ModelRef,
  ModelV2Info,
  ProviderV2Info,
  QuestionV2Reply,
  SessionDurableEvent,
  SessionInputAdmitted,
  SessionV2Info,
  V2Event,
};

export interface OcClientOptions {
  /** Same-origin proxy root in the renderer (`` `${location.origin}/oc` ``);
   *  a direct opencode URL in tests/E2E. */
  baseUrl: string;
  /** Defaults to the SDK's own default (global `fetch`). */
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request (the Electron proxy injects Basic auth
   *  server-side, so the renderer passes none). */
  headers?: Record<string, string>;
}

/** Thrown for non-2xx responses from the v1-compat shim below. */
export class OcApiError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, body: string) {
    super(`opencode ${path} → ${status}: ${body.slice(0, 300)}`);
    this.name = "OcApiError";
    this.status = status;
    this.path = path;
  }
}

export interface OcSessionPage {
  sessions: SessionV2Info[];
  nextCursor?: string;
}

export interface OcHistoryPage {
  events: SessionDurableEvent[];
  hasMore: boolean;
}

export interface OcStreamOptions {
  signal: AbortSignal;
}

export interface OcClient {
  /** Raw SDK client escape hatch (provider/model/agent listings for the
   *  model picker, permission/question replies beyond the helpers). */
  readonly sdk: SdkClient;
  /** Base URL the client was created with (always without trailing `/`). */
  readonly baseUrl: string;

  listSessions(opts?: {
    directory?: string;
    limit?: number;
    cursor?: string;
    order?: "asc" | "desc";
  }): Promise<OcSessionPage>;
  createSession(opts: {
    directory: string;
    model?: ModelRef;
    agent?: string;
  }): Promise<SessionV2Info>;
  getSession(sessionID: string): Promise<SessionV2Info>;
  /** Admit one input and schedule execution. Pass a client-minted `id` so
   *  the durable `prompt.admitted`/`prompted` events echo it as `messageID`
   *  and the optimistic user bubble reconciles by key. */
  prompt(
    sessionID: string,
    text: string,
    opts?: { id?: string; resume?: boolean },
  ): Promise<SessionInputAdmitted>;
  interrupt(sessionID: string): Promise<void>;
  switchModel(sessionID: string, model: ModelRef): Promise<void>;
  history(
    sessionID: string,
    after?: number,
    limit?: number,
  ): Promise<OcHistoryPage>;
  /**
   * No v2 delete route exists in 1.18.30 — documented shim over the v1
   * compat route (`DELETE /session/:id`). Idempotent: 404 (already gone)
   * resolves.
   */
  deleteSession(sessionID: string): Promise<void>;
  /**
   * One-shot read of the foreground drains (`/api/session/active`) —
   * sessions absent from the set are idle. For resume-time seeding only
   * (initial list, stream reopen); turn state otherwise comes from events,
   * never polling. Mirrors the official GUI's bootstrap seeding.
   */
  activeSessionIDs(): Promise<Set<string>>;

  listProviders(): Promise<ProviderV2Info[]>;
  listModels(): Promise<ModelV2Info[]>;
  listAgents(): Promise<AgentV2Info[]>;
  replyPermission(
    sessionID: string,
    requestID: string,
    reply: PermissionV2Reply,
    message?: string,
  ): Promise<void>;
  answerQuestion(
    sessionID: string,
    requestID: string,
    answers: QuestionV2Reply,
  ): Promise<void>;
  rejectQuestion(sessionID: string, requestID: string): Promise<void>;

  /**
   * One session's durable events: replays everything after `after`, then
   * follows with new durable events. Delta fragments (`*.delta`) are
   * live-only and arrive on {@link openEventBus}, not here. Ends when
   * `signal` aborts (the SDK client retries transparently otherwise).
   */
  openSessionStream(
    sessionID: string,
    after: number,
    opts: OcStreamOptions,
  ): AsyncGenerator<SessionDurableEvent>;
  /** Server-wide bus: live-only deltas, `session.status`, session
   *  create/update/delete, permission/question asks. Ends on abort. */
  openEventBus(opts: OcStreamOptions): AsyncGenerator<V2Event>;
}

/** Normalize one SSE yield into an event object. The codegen types the
 *  session stream as an `{id, event, data}` envelope, but on the wire each
 *  `data:` block parses to the event itself (verified live in stage 1 with
 *  a manual parser); accept strings, envelopes, and bare events. */
function asEvent(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object" && raw !== null) {
    const record = raw as Record<string, unknown>;
    if (typeof record.type === "string") return record;
    const inner = record.data;
    if (typeof inner === "string") return asEvent(inner);
    if (typeof inner === "object" && inner !== null) {
      const innerRecord = inner as Record<string, unknown>;
      if (typeof innerRecord.type === "string") return innerRecord;
    }
  }
  return null;
}

export function createOcClient(options: OcClientOptions): OcClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const sdk = createOpencodeClient({
    baseUrl,
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.headers !== undefined ? { headers: options.headers } : {}),
    // Throw on non-2xx so failures surface instead of resolving undefined.
    throwOnError: true,
  });
  // Raw fetch for the v1-compat delete shim (no SDK method exists).
  const rawFetch = options.fetch ?? globalThis.fetch;

  async function* openSessionStream(
    sessionID: string,
    after: number,
    { signal }: OcStreamOptions,
  ): AsyncGenerator<SessionDurableEvent> {
    const { stream } = await sdk.v2.session.events(
      { sessionID, after: String(after) },
      { signal },
    );
    for await (const raw of stream) {
      if (signal.aborted) return;
      const event = asEvent(raw);
      if (event !== null) yield event as unknown as SessionDurableEvent;
    }
  }

  async function* openEventBus({
    signal,
  }: OcStreamOptions): AsyncGenerator<V2Event> {
    const { stream } = await sdk.v2.event.subscribe({ signal });
    for await (const raw of stream) {
      if (signal.aborted) return;
      const event = asEvent(raw);
      if (event !== null) yield event as unknown as V2Event;
    }
  }

  return {
    sdk,
    baseUrl,

    async listSessions(opts = {}) {
      const { data } = await sdk.v2.session.list<true>({
        ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
        ...(opts.order !== undefined ? { order: opts.order } : {}),
      });
      return {
        sessions: data.data,
        ...(data.cursor.next !== undefined
          ? { nextCursor: data.cursor.next }
          : {}),
      };
    },

    async createSession(opts) {
      const { data } = await sdk.v2.session.create<true>({
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        location: { directory: opts.directory },
      });
      // Create/get/prompt bodies wrap once more (`{data: …}`).
      return data.data;
    },

    async getSession(sessionID) {
      const { data } = await sdk.v2.session.get<true>({ sessionID });
      return data.data;
    },

    async prompt(sessionID, text, opts = {}) {
      const { data } = await sdk.v2.session.prompt<true>({
        sessionID,
        prompt: { text },
        ...(opts.id !== undefined ? { id: opts.id } : {}),
        ...(opts.resume === true ? { resume: true } : {}),
      });
      return data.data;
    },

    async interrupt(sessionID) {
      await sdk.v2.session.interrupt<true>({ sessionID });
    },

    async switchModel(sessionID, model) {
      await sdk.v2.session.switchModel<true>({ sessionID, model });
    },

    async history(sessionID, after = 0, limit = 100) {
      const { data } = await sdk.v2.session.history<true>({
        sessionID,
        after,
        limit,
      });
      return { events: data.data, hasMore: data.hasMore };
    },

    async deleteSession(sessionID) {
      const res = await rawFetch(
        `${baseUrl}/session/${encodeURIComponent(sessionID)}`,
        { method: "DELETE", headers: options.headers },
      );
      if (res.status === 404) return;
      if (!res.ok) {
        throw new OcApiError(
          res.status,
          `/session/${sessionID}`,
          await res.text().catch(() => ""),
        );
      }
    },

    async activeSessionIDs() {
      const { data } = await sdk.v2.session.active<true>();
      return new Set(Object.keys(data.data));
    },

    async listProviders() {
      const { data } = await sdk.v2.provider.list<true>();
      return data.data;
    },

    async listModels() {
      const { data } = await sdk.v2.model.list<true>();
      return data.data;
    },

    async listAgents() {
      const { data } = await sdk.v2.agent.list<true>();
      return data.data;
    },

    async replyPermission(sessionID, requestID, reply, message) {
      await sdk.v2.session.permission.reply<true>({
        sessionID,
        requestID,
        reply,
        ...(message !== undefined ? { message } : {}),
      });
    },

    async answerQuestion(sessionID, requestID, answers) {
      await sdk.v2.session.question.reply<true>({
        sessionID,
        requestID,
        questionV2Reply: answers,
      });
    },

    async rejectQuestion(sessionID, requestID) {
      await sdk.v2.session.question.reject<true>({ sessionID, requestID });
    },

    openSessionStream,
    openEventBus,
  };
}
