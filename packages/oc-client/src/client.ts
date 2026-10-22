/**
 * Framework-agnostic opencode 2 client for Thinkite frontends.
 *
 * Thin wrapper over the published `@opencode/client` promise entry (exact
 * pin in `package.json`; the service it talks to is discovered from the
 * opencode registry, never spawned by us) plus the few helpers the UI and
 * the store needs.
 *
 * Runtime constraints (the phone reuses this on Hermes): no
 * `node:*` imports, no DOM-only globals beyond what Expo provides (`fetch`,
 * `ReadableStream`, `TextDecoder`), no `Buffer`. The promise entry itself
 * only needs `fetch` + streaming bodies (verified: 32 KB browser bundle,
 * no `effect` at runtime).
 */

import {
  type AgentInfo,
  isSessionNotFoundError,
  type ModelInfo,
  type ModelRef,
  OpenCode,
  type OpenCodeClient,
  type OpenCodeEvent,
  type PermissionReplyInput,
  type ProviderInfo,
  type ServerInfo,
  type SessionInboxUser,
  type SessionInfo,
  type SessionMessageInfo,
} from "@opencode/client";

export type {
  AgentInfo,
  ModelInfo,
  ModelRef,
  OpenCodeClient,
  OpenCodeEvent,
  ProviderInfo,
  ServerInfo,
  SessionInboxUser,
  SessionInfo,
  SessionMessageInfo,
};

export interface OcClientOptions {
  /** Origin (or direct opencode URL). The generated client resolves every
   *  route with `new URL("/api/…", baseUrl)`, so a path on `baseUrl` is
   *  dropped — use `pathPrefix` for the Electron `/oc` proxy instead. */
  baseUrl: string;
  /** Mount prefix inserted before `/api/…` (desktop passes `/oc`). */
  pathPrefix?: string;
  /** Defaults to the global `fetch` (the phone injects its iroh shim). */
  fetch?: typeof globalThis.fetch;
  /** Basic-auth password for a direct connection (tests, E2E, daemon). The
   *  desktop proxy injects credentials server-side, so the renderer passes
   *  none. Username is always `opencode`. */
  password?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

export interface OcSessionPage {
  sessions: SessionInfo[];
  nextCursor?: string;
}

export interface OcMessagePage {
  /** Server order for the call: newest first on the first page
   *  (`order: "desc"`), continuing older along `nextCursor`. */
  messages: SessionMessageInfo[];
  nextCursor?: string;
}

export interface OcEventStreamOptions {
  signal: AbortSignal;
  /** Fires on every received chunk, keepalive comments included. */
  onActivity?: () => void;
}

export interface OcClient {
  /** Raw generated client escape hatch. */
  readonly raw: OpenCodeClient;
  readonly baseUrl: string;

  /** Version and identity of the attached service. */
  info(): Promise<ServerInfo>;
  listSessions(opts?: {
    directory?: string;
    limit?: number;
    cursor?: string;
  }): Promise<OcSessionPage>;
  createSession(opts: {
    directory: string;
    title?: string;
    model?: ModelRef;
    agent?: string;
  }): Promise<SessionInfo>;
  getSession(sessionID: string): Promise<SessionInfo>;
  /** Idempotent: an already-deleted session resolves. */
  deleteSession(sessionID: string): Promise<void>;
  /** One page of the `session_message` projection — the only history
   *  source on a local service (no durable event replay, see the 4a
   *  report). A cursor cannot be combined with `order`, so the first page
   *  asks for `desc` and later pages pass only the cursor. */
  listMessages(
    sessionID: string,
    opts?: { limit?: number; cursor?: string },
  ): Promise<OcMessagePage>;
  /** Admit one input. Pass a client-minted `msg_*` `id` so the durable
   *  `session.inbox.enqueued` event (and the projection row) carry it and
   *  the optimistic user bubble reconciles by key. */
  prompt(
    sessionID: string,
    text: string,
    opts?: { id?: string },
  ): Promise<SessionInboxUser>;
  interrupt(sessionID: string): Promise<void>;
  switchModel(sessionID: string, model: ModelRef): Promise<void>;
  /** Foreground drains owned by the service — sessions absent are idle. A
   *  resume-time seed (startup, every `server.connected`); turn state
   *  otherwise comes from `session.execution.*` events. */
  activeSessionIDs(): Promise<Set<string>>;
  listProviders(directory?: string): Promise<ProviderInfo[]>;
  listModels(directory?: string): Promise<ModelInfo[]>;
  listAgents(directory?: string): Promise<AgentInfo[]>;
  replyPermission(
    sessionID: string,
    requestID: string,
    decision: PermissionReplyInput["decision"],
    message?: string,
  ): Promise<void>;
  /**
   * The global `/api/event` stream. One connection per client, fanned out
   * to every subscriber (`SharedEvents` inside `@opencode/client`); the
   * first event of every (re)connection is `server.connected`. No
   * reconnect inside — see `subscribeEvents` in `events.ts`.
   */
  events(opts: OcEventStreamOptions): AsyncIterable<OpenCodeEvent>;
}

function base64(input: string): string {
  // `btoa` exists in browsers, Electron, Node ≥ 16 and Hermes/Expo.
  return btoa(input);
}

function prefixedFetch(
  fetchImpl: typeof globalThis.fetch,
  prefix: string,
): typeof globalThis.fetch {
  const rewrite = (url: string): string => {
    const parsed = new URL(url);
    if (parsed.pathname.startsWith("/api/") || parsed.pathname === "/api") {
      parsed.pathname = `${prefix}${parsed.pathname}`;
    }
    return parsed.toString();
  };
  return (input, init) => {
    if (typeof input === "string") return fetchImpl(rewrite(input), init);
    if (input instanceof URL) return fetchImpl(rewrite(input.toString()), init);
    return fetchImpl(new Request(rewrite(input.url), input), init);
  };
}

export function createOcClient(options: OcClientOptions): OcClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const prefix = options.pathPrefix?.replace(/\/+$/, "") ?? "";
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.password !== undefined) {
    headers.authorization = `Basic ${base64(`opencode:${options.password}`)}`;
  }
  const raw = OpenCode.make({
    baseUrl,
    fetch: prefix === "" ? fetchImpl : prefixedFetch(fetchImpl, prefix),
    headers,
  });

  const location = (directory?: string) =>
    directory === undefined ? {} : { location: { directory } };

  return {
    raw,
    baseUrl,

    info() {
      return raw.server.info();
    },

    async listSessions(opts = {}) {
      const page = await raw.session.list({
        ...(opts.directory !== undefined ? { directory: opts.directory } : {}),
        // Root sessions only: subagent sessions belong under their parent.
        parentID: null,
        limit: opts.limit ?? 100,
        ...(opts.cursor !== undefined
          ? { cursor: opts.cursor }
          : { order: "desc" as const }),
      });
      return { sessions: page.data, nextCursor: page.cursor.next ?? undefined };
    },

    createSession(opts) {
      return raw.session.create({
        location: { directory: opts.directory },
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.model !== undefined ? { model: opts.model } : {}),
        ...(opts.agent !== undefined ? { agent: opts.agent } : {}),
      });
    },

    getSession(sessionID) {
      return raw.session.get({ sessionID });
    },

    async deleteSession(sessionID) {
      try {
        await raw.session.remove({ sessionID });
      } catch (err) {
        if (isSessionNotFoundError(err)) return;
        throw err;
      }
    },

    async listMessages(sessionID, opts = {}) {
      const page = await raw.message.list({
        sessionID,
        limit: opts.limit ?? 100,
        ...(opts.cursor !== undefined
          ? { cursor: opts.cursor }
          : { order: "desc" as const }),
      });
      return { messages: page.data, nextCursor: page.cursor.next ?? undefined };
    },

    prompt(sessionID, text, opts = {}) {
      return raw.session.prompt({
        sessionID,
        text,
        ...(opts.id !== undefined ? { id: opts.id } : {}),
      });
    },

    async interrupt(sessionID) {
      await raw.session.interrupt({ sessionID });
    },

    async switchModel(sessionID, model) {
      await raw.session.switchModel({ sessionID, model });
    },

    async activeSessionIDs() {
      const active = await raw.session.active();
      return new Set(Object.keys(active));
    },

    async listProviders(directory) {
      return (await raw.provider.list(location(directory))).data;
    },

    async listModels(directory) {
      return (await raw.model.list(location(directory))).data;
    },

    async listAgents(directory) {
      return (await raw.agent.list(location(directory))).data;
    },

    async replyPermission(sessionID, requestID, decision, message) {
      await raw.permission.reply({
        sessionID,
        requestID,
        decision,
        ...(message !== undefined ? { message } : {}),
      });
    },

    events(opts) {
      return raw.event.subscribe({
        signal: opts.signal,
        ...(opts.onActivity !== undefined
          ? { onActivity: opts.onActivity }
          : {}),
      });
    },
  };
}
