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
  type CommandInfo,
  type FormAnswer,
  type IntegrationAttempt,
  type IntegrationAttemptStatus,
  type IntegrationInfo,
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
  type SessionRevert,
  type SkillInfo,
} from "@opencode/client";

export type {
  AgentInfo,
  CommandInfo,
  FormAnswer,
  IntegrationAttempt,
  IntegrationAttemptStatus,
  IntegrationInfo,
  ModelInfo,
  ModelRef,
  OpenCodeClient,
  OpenCodeEvent,
  ProviderInfo,
  ServerInfo,
  SessionInboxUser,
  SessionInfo,
  SessionMessageInfo,
  SessionRevert,
  SkillInfo,
};

/** A form's answers as the UI holds them (lists may be readonly). */
export type FormInput = Readonly<
  Record<string, string | number | boolean | readonly string[]>
>;

/** The service's own shape for the same answers. */
const formAnswer = (answer: FormInput): FormAnswer =>
  Object.fromEntries(
    Object.entries(answer).map(([k, v]) => [k, Array.isArray(v) ? [...v] : v]),
  ) as FormAnswer;

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

/**
 * A file sent with a prompt. A `data:` URI is stored inline on the user
 * message (how the phone sends photos); a path or `file:` URI is read by
 * the service.
 */
export interface PromptFile {
  uri: string;
  name?: string;
  /** Where the prompt text names it (`@path`), for files picked from @. */
  mention?: PromptMention;
}

/** A span of the prompt text that names an attachment, such as `@General`. */
export interface PromptMention {
  start: number;
  end: number;
  text: string;
}

/** What a prompt or a command carries besides its text. */
export interface PromptParts {
  files?: readonly PromptFile[];
  /** Subagents named with @. */
  agents?: readonly { name: string; mention?: PromptMention }[];
  /** Skills named with @. */
  skills?: readonly { id: string; mention?: PromptMention }[];
}

/** A path a file search matched, relative to the directory searched. */
export interface FoundPath {
  path: string;
  type: "file" | "directory";
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
  renameSession(sessionID: string, title: string): Promise<void>;
  /** Archived sessions keep their history but leave `listSessions`. */
  archiveSession(sessionID: string): Promise<void>;
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
    opts?: { id?: string } & PromptParts,
  ): Promise<SessionInboxUser>;
  /** Run a command the service defines (`/review …`); `text` is its arguments. */
  command(
    sessionID: string,
    name: string,
    text: string,
    parts?: PromptParts,
  ): Promise<void>;
  /** Summarize the session to free context. */
  compact(sessionID: string): Promise<void>;
  interrupt(sessionID: string): Promise<void>;
  /** Resolves once the session's work has settled; at once when idle. */
  wait(sessionID: string): Promise<void>;
  /**
   * Rewind to just before user message `messageID`: it and everything after
   * it are hidden and the files the later turns changed are put back. The
   * next prompt makes it final; `unrevert` takes it back. Fails while busy.
   */
  revert(sessionID: string, messageID: string): Promise<SessionRevert>;
  unrevert(sessionID: string): Promise<void>;
  /** A new session with the history before `before` (all of it without). */
  fork(sessionID: string, before?: string): Promise<SessionInfo>;
  switchModel(sessionID: string, model: ModelRef): Promise<void>;
  /** Foreground drains owned by the service — sessions absent are idle. A
   *  resume-time seed (startup, every `server.connected`); turn state
   *  otherwise comes from `session.execution.*` events. */
  activeSessionIDs(): Promise<Set<string>>;
  listProviders(directory?: string): Promise<ProviderInfo[]>;
  listModels(directory?: string): Promise<ModelInfo[]>;
  /** The model a session in `directory` runs on when it names none: the
   *  project's configured model, else the user's. */
  defaultModel(directory?: string): Promise<ModelRef | undefined>;
  listAgents(directory?: string): Promise<AgentInfo[]>;
  listCommands(directory?: string): Promise<CommandInfo[]>;
  listSkills(directory?: string): Promise<SkillInfo[]>;
  /** Fuzzy path search under `directory`, files and directories alike. */
  findFiles(
    directory: string,
    query: string,
    limit?: number,
  ): Promise<FoundPath[]>;
  /** Every provider the service can connect: how (methods) and what is
   *  connected now (connections; the active credential first). */
  listIntegrations(): Promise<IntegrationInfo[]>;
  /** Store an API key; `answer` fills the method's form, if it has one.
   *  Without a `label` the service names it after the provider ("DeepSeek",
   *  then "DeepSeek 2" while that one exists). */
  connectKey(
    integrationID: string,
    key: string,
    answer?: FormInput,
    label?: string,
  ): Promise<void>;
  /** Use credentials found outside opencode (an AWS profile, gcloud). */
  connectExternal(
    integrationID: string,
    methodID: string,
    answer?: FormInput,
  ): Promise<void>;
  /** Start a sign-in: open `url`; mode "auto" finishes on its own (poll
   *  `oauthStatus`), mode "code" needs the code the page shows. */
  startOAuth(
    integrationID: string,
    methodID: string,
    answer?: FormInput,
  ): Promise<IntegrationAttempt>;
  oauthStatus(
    integrationID: string,
    attemptID: string,
  ): Promise<IntegrationAttemptStatus>;
  completeOAuth(
    integrationID: string,
    attemptID: string,
    code?: string,
  ): Promise<void>;
  cancelOAuth(integrationID: string, attemptID: string): Promise<void>;
  renameCredential(credentialID: string, label: string): Promise<void>;
  /** Make this account the one its provider uses. */
  activateCredential(credentialID: string): Promise<void>;
  removeCredential(credentialID: string): Promise<void>;
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
        // The service lists archived sessions too unless asked not to.
        archived: false,
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

    async listIntegrations() {
      return (await raw.integration.list()).data;
    },

    async connectKey(integrationID, key, answer, label) {
      await raw.integration.connect.key({
        integrationID,
        key,
        ...(answer !== undefined ? { answer: formAnswer(answer) } : {}),
        ...(label !== undefined ? { label } : {}),
      });
    },

    async connectExternal(integrationID, methodID, answer) {
      await raw.integration.connect.external({
        integrationID,
        methodID,
        ...(answer !== undefined ? { answer: formAnswer(answer) } : {}),
      });
    },

    async startOAuth(integrationID, methodID, answer) {
      return (
        await raw.integration.oauth.connect({
          integrationID,
          methodID,
          ...(answer !== undefined ? { answer: formAnswer(answer) } : {}),
        })
      ).data;
    },

    async oauthStatus(integrationID, attemptID) {
      return (await raw.integration.oauth.status({ integrationID, attemptID }))
        .data;
    },

    async completeOAuth(integrationID, attemptID, code) {
      await raw.integration.oauth.complete({
        integrationID,
        attemptID,
        ...(code !== undefined ? { code } : {}),
      });
    },

    async cancelOAuth(integrationID, attemptID) {
      await raw.integration.oauth.cancel({ integrationID, attemptID });
    },

    async renameCredential(credentialID, label) {
      await raw.credential.update({ credentialID, label });
    },

    async activateCredential(credentialID) {
      await raw.credential.activate({ credentialID });
    },

    async removeCredential(credentialID) {
      await raw.credential.remove({ credentialID });
    },

    async renameSession(sessionID, title) {
      await raw.session.update({ sessionID, title });
    },

    async archiveSession(sessionID) {
      await raw.session.update({ sessionID, archived: true });
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
        ...nonEmptyParts(opts),
      });
    },

    async command(sessionID, name, text, parts = {}) {
      await raw.session.command({
        sessionID,
        name,
        text,
        ...nonEmptyParts(parts),
      });
    },

    async compact(sessionID) {
      await raw.session.compact({ sessionID });
    },

    async interrupt(sessionID) {
      await raw.session.interrupt({ sessionID });
    },

    async wait(sessionID) {
      await raw.session.wait({ sessionID });
    },

    revert(sessionID, messageID) {
      return raw.session.revert.stage({ sessionID, messageID });
    },

    async unrevert(sessionID) {
      await raw.session.revert.clear({ sessionID });
    },

    fork(sessionID, before) {
      return raw.session.fork({
        sessionID,
        ...(before !== undefined ? { before } : {}),
      });
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

    async defaultModel(directory) {
      const m = (await raw.model.default(location(directory))).data;
      return m ? { providerID: m.providerID, id: m.id } : undefined;
    },

    async listAgents(directory) {
      return (await raw.agent.list(location(directory))).data;
    },

    async listCommands(directory) {
      return (await raw.command.list(location(directory))).data;
    },

    async listSkills(directory) {
      return (await raw.skill.list(location(directory))).data;
    },

    async findFiles(directory, query, limit) {
      const found = await raw.file.find({
        location: { directory },
        query,
        ...(limit !== undefined ? { limit } : {}),
      });
      return found.data;
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

/** The parts that have entries; the service's lists may not be empty-but-present. */
function nonEmptyParts(parts: PromptParts): PromptParts {
  return {
    ...(parts.files?.length ? { files: parts.files } : {}),
    ...(parts.agents?.length ? { agents: parts.agents } : {}),
    ...(parts.skills?.length ? { skills: parts.skills } : {}),
  };
}
