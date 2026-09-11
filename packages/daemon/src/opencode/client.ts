/**
 * Thin `fetch`-based client for the opencode v2 HTTP API (`/api/...`).
 *
 * Only `fetch` / `AbortController` / `TextDecoder` — no Node-only imports —
 * so this works under Node (production) and bun (dev) alike. Every request
 * carries Basic auth (the server is spawned with random credentials by
 * `host.ts`; direct unauthenticated hits 401).
 *
 * Endpoint shapes mirror `../opencode/packages/protocol/src/groups/*.ts`
 * (v2 routes) at opencode 1.18.30. The legacy v1 surface is used for one
 * call only: session delete (`DELETE /session/:id`, no v2 equivalent).
 */

export interface OpencodeModelRef {
  providerID: string;
  id: string;
}

/** Durable event envelope as returned by history / the session event stream. */
export interface OpencodeDurableEvent {
  id: string;
  type: string;
  durable?: { aggregateID: string; seq: number; version: number };
  data: Record<string, unknown>;
}

/** Live event envelope as published on the global bus (`/api/event`). */
export interface OpencodeLiveEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
  location?: { directory: string };
}

export interface OpencodeSessionInfo {
  id: string;
  title?: string;
  directory?: string;
  model?: OpencodeModelRef & { variant?: string };
}

export interface PromptAdmitted {
  admittedSeq: number;
  id: string;
  sessionID: string;
}

/** Thrown for non-2xx opencode responses so callers surface it as turn_failed. */
export class OpencodeApiError extends Error {
  readonly status: number;
  readonly path: string;
  constructor(status: number, path: string, body: string) {
    super(`opencode ${path} → ${status}: ${body.slice(0, 300)}`);
    this.name = "OpencodeApiError";
    this.status = status;
    this.path = path;
  }
}

const SSE_TIMEOUT_MS = 30_000;

export class OpencodeClient {
  private readonly base: string;
  private readonly auth: string;

  constructor(baseUrl: string | URL, username: string, password: string) {
    // Normalized without trailing slash; paths below always start with `/`.
    this.base = String(baseUrl).replace(/\/+$/, "");
    this.auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: this.auth,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text };
  }

  private async requestJson<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const { status, text } = await this.request(method, path, body);
    if (status < 200 || status >= 300) {
      throw new OpencodeApiError(status, path, text);
    }
    return JSON.parse(text) as T;
  }

  /** `/global/health` with Basic auth (unauthenticated → 401). */
  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.base}/global/health`, {
        headers: { authorization: this.auth },
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // ─── Sessions ──────────────────────────────────────────────────────

  async createSession(input: {
    directory: string;
    model?: OpencodeModelRef;
    agent?: string;
  }): Promise<OpencodeSessionInfo> {
    // No `id`: the SessionID brand requires a `ses_` prefix, so the server
    // mints the id. Thinkite keeps its own session id and maps it via
    // sidecode metadata (`opencodeSessionId`).
    const json = await this.requestJson<{ data: OpencodeSessionInfo }>(
      "POST",
      "/api/session",
      {
        location: { directory: input.directory },
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.agent !== undefined ? { agent: input.agent } : {}),
      },
    );
    return json.data;
  }

  /** Undefined when the session does not exist (404), throws otherwise. */
  async getSession(
    sessionID: string,
  ): Promise<OpencodeSessionInfo | undefined> {
    const { status, text } = await this.request(
      "GET",
      `/api/session/${sessionID}`,
    );
    if (status === 404) return undefined;
    if (status < 200 || status >= 300) {
      throw new OpencodeApiError(status, `/api/session/${sessionID}`, text);
    }
    return (JSON.parse(text) as { data: OpencodeSessionInfo }).data;
  }

  async listSessions(directory?: string): Promise<OpencodeSessionInfo[]> {
    const q =
      directory !== undefined
        ? `?directory=${encodeURIComponent(directory)}`
        : "";
    const json = await this.requestJson<{ data: OpencodeSessionInfo[] }>(
      "GET",
      `/api/session${q}`,
    );
    return json.data;
  }

  /** Foreground drains owned by this server process (idle sessions absent). */
  async activeSessions(): Promise<Record<string, { type: string }>> {
    const json = await this.requestJson<{
      data: Record<string, { type: string }>;
    }>("GET", "/api/session/active");
    return json.data;
  }

  /**
   * No v2 delete route exists in 1.18.30 — use the v1 compat route
   * (`DELETE /session/:id`, returns `true`). Cascades the session's
   * events: subsequent history reads 404.
   */
  async deleteSession(sessionID: string): Promise<void> {
    await this.requestJson("DELETE", `/session/${sessionID}`);
  }

  async switchModel(sessionID: string, model: OpencodeModelRef): Promise<void> {
    await this.requestJson("POST", `/api/session/${sessionID}/model`, {
      model,
    });
  }

  // ─── Turns ─────────────────────────────────────────────────────────

  async prompt(
    sessionID: string,
    text: string,
    opts: {
      resume?: boolean;
      files?: Array<{ uri: string; mime: string; name?: string }>;
    } = {},
  ): Promise<PromptAdmitted> {
    const json = await this.requestJson<{ data: PromptAdmitted }>(
      "POST",
      `/api/session/${sessionID}/prompt`,
      {
        prompt: {
          text,
          ...(opts.files !== undefined && opts.files.length > 0
            ? { files: opts.files }
            : {}),
        },
        ...(opts.resume === true ? { resume: true } : {}),
      },
    );
    return json.data;
  }

  /**
   * Best-effort interrupt. Resolves on 2xx (idle interrupt is a server-side
   * no-op); 404 (session gone) is also a no-op so router semantics stay
   * best-effort like the SDK path.
   */
  async interrupt(sessionID: string): Promise<void> {
    const { status, text } = await this.request(
      "POST",
      `/api/session/${sessionID}/interrupt`,
    );
    if (status === 404) return;
    if (status < 200 || status >= 300) {
      throw new OpencodeApiError(
        status,
        `/api/session/${sessionID}/interrupt`,
        text,
      );
    }
  }

  // ─── History ───────────────────────────────────────────────────────

  async history(
    sessionID: string,
    after = 0,
    limit = 100,
  ): Promise<{ events: OpencodeDurableEvent[]; hasMore: boolean }> {
    const json = await this.requestJson<{
      data: OpencodeDurableEvent[];
      hasMore: boolean;
    }>(
      "GET",
      `/api/session/${sessionID}/history?after=${after}&limit=${limit}`,
    );
    return { events: json.data, hasMore: json.hasMore };
  }

  // ─── Event streams (SSE) ───────────────────────────────────────────
  //
  // Lazy SSE headers gotcha: the server flushes headers with the first
  // event, so callers must open the stream AND send the prompt
  // concurrently — never `await` stream-open before prompting.

  /**
   * Subscribe to one session's durable events: replays everything after
   * `after`, then follows with new events. Resolves once response headers
   * arrive (bounded by SSE_TIMEOUT_MS); `done` settles when the stream
   * ends or `abort()` is called.
   */
  async subscribeSession(
    sessionID: string,
    after: number,
    onEvent: (e: OpencodeDurableEvent) => void,
    signal: AbortSignal,
  ): Promise<{ status: number; done: Promise<void> }> {
    return this.openSse(
      `/api/session/${sessionID}/event?after=${after}`,
      onEvent,
      signal,
    );
  }

  /** Server-wide live bus. Carries the live-only deltas (`*.delta`) plus
   *  permission/question asks that the host auto-replies to. */
  async subscribeGlobal(
    onEvent: (e: OpencodeLiveEvent) => void,
    signal: AbortSignal,
  ): Promise<{ status: number; done: Promise<void> }> {
    return this.openSse("/api/event", onEvent, signal);
  }

  private async openSse<T>(
    path: string,
    onEvent: (e: T) => void,
    signal: AbortSignal,
  ): Promise<{ status: number; done: Promise<void> }> {
    // Bound the lazy-headers window: the server flushes headers with the
    // first event, so `fetch` itself may hang when there is nothing to
    // replay yet. Callers open the stream and send the prompt concurrently.
    const res = await Promise.race([
      fetch(`${this.base}${path}`, {
        headers: { authorization: this.auth, accept: "text/event-stream" },
        signal,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`opencode SSE headers timeout: ${path}`)),
          SSE_TIMEOUT_MS,
        ),
      ),
    ]);
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      throw new OpencodeApiError(res.status, path, text);
    }
    const done = (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      try {
        for (;;) {
          const { value, done: readerDone } = await reader.read();
          if (readerDone) return;
          buf += decoder.decode(value, { stream: true });
          let idx = buf.indexOf("\n\n");
          while (idx >= 0) {
            const block = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = block
              .split("\n")
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trim())
              .join("");
            if (data.length > 0) {
              try {
                onEvent(JSON.parse(data) as T);
              } catch {
                // Malformed SSE data block — skip, the stream stays usable.
              }
            }
            idx = buf.indexOf("\n\n");
          }
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") return;
        throw err;
      } finally {
        reader.releaseLock();
      }
    })();
    return { status: res.status, done };
  }

  // ─── Permissions / questions (auto-reply backstop) ─────────────────

  /** `reply`: "once" (allow this step) | "always" | "reject". */
  async replyPermission(
    sessionID: string,
    requestID: string,
    reply: "once" | "always" | "reject",
    message?: string,
  ): Promise<void> {
    await this.requestJson(
      "POST",
      `/api/session/${sessionID}/permission/${requestID}/reply`,
      { reply, ...(message !== undefined ? { message } : {}) },
    );
  }

  async rejectQuestion(sessionID: string, requestID: string): Promise<void> {
    await this.requestJson(
      "POST",
      `/api/session/${sessionID}/question/${requestID}/reject`,
    );
  }
}
