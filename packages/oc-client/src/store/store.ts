/**
 * opencode server state as TanStack Store atoms, one per field of the
 * `Store` in opencode's `createData` (`packages/client/src/solid/data.ts`,
 * v2.1.2, MIT): the same paths, records keyed by server ids, rows of the
 * protocol's own types. `store.session.info[id]` there is
 * `store.session.info.get()[id]` here.
 *
 * Not mirrored: `session.family`, `session.pending` (the inbox),
 * `project.*`, and the per-location lists.
 *
 * The bus can deliver hundreds of deltas a second while a turn streams, so
 * writes are staged as updaters and applied together once per frame inside
 * one `batch`: each updater still reads the value the one before it left,
 * and subscribers hear about the frame once. `flush()` applies what is
 * staged right away, for user actions and for code that reads back.
 *
 * Optimistic prompts follow createData's `prompt()` / `sendAdmission` /
 * `outbox`: the user row shows at once under a client-minted `msg_*` id; the
 * durable `session.inbox.enqueued` echo replaces that row in place; a failed
 * send takes the row back only if this call added it and no echo arrived; a
 * refetch keeps it (`mergeProjection` keeps rows the page lacks); sends for
 * one session go out in submission order.
 */

import {
  type FormInfo,
  isFormAlreadySettledError,
  isFormNotFoundError,
  isPermissionNotFoundError,
  type PermissionRequest,
} from "@opencode/client";
import {
  type Atom,
  batch,
  createAtom,
  type ReadonlyAtom,
} from "@tanstack/store";
import type {
  ModelRef,
  OcClient,
  PromptFile,
  SessionInfo,
  SessionMessageInfo,
} from "../client.ts";
import { type OcEvent, sessionIDOf, subscribeEvents } from "../events.ts";
import { mintMessageId } from "../identifier.ts";
import { formatModelRef } from "../model-ref.ts";
import {
  applySessionEvent,
  type SessionStatus,
  statusFromEvent,
} from "../session-reducer.ts";
import {
  applyTranscriptEvent,
  mergeProjection,
  STREAMING_EVENT_TYPES,
  type TranscriptRows,
  TURN_END_EVENT_TYPES,
} from "../transcript-reducer.ts";
import { drop, put, type Records, removeIn, upsertIn } from "./records.ts";

export interface Paging {
  /** Cursor for the next older page; undefined once the start is loaded. */
  cursor: string | undefined;
  /** First page read finished (rows may still be empty). */
  hydrated: boolean;
  loadingOlder: boolean;
}

export type ConnectionStatus = "idle" | "connecting" | "ready" | "error";

export type FormAnswer = Record<
  string,
  string | number | boolean | readonly string[]
>;

export interface OcStoreOptions {
  client: OcClient;
  /** Messages per projection read. */
  pageSize?: number;
  /** Transcripts kept (and folded live) after leaving them. */
  keepTranscripts?: number;
  /** Trailing window for event bursts that each ask for the same refetch. */
  settleMs?: number;
  frameMs?: number;
  onError?: (scope: string, error: unknown) => void;
}

export interface OcStore {
  readonly client: OcClient;
  readonly status: Atom<{ status: ConnectionStatus; error: string | null }>;
  readonly session: {
    readonly info: Atom<Records<SessionInfo>>;
    readonly active: Atom<Records<SessionStatus>>;
    /** Transcripts by session, oldest first; only sessions opened lately. */
    readonly message: Atom<Records<TranscriptRows>>;
    readonly permission: Atom<Records<readonly PermissionRequest[]>>;
    readonly form: Atom<Records<readonly FormInfo[]>>;
    readonly paging: Atom<Records<Paging>>;
  };
  /** Permission requests and forms whose answer is on its way. */
  readonly replying: Atom<Records<true>>;
  /** Root sessions, most recent first. */
  readonly rootSessions: ReadonlyAtom<readonly SessionInfo[]>;
  /** Sessions with a turn in flight. */
  readonly running: ReadonlyAtom<ReadonlySet<string>>;

  /** Read the session list and follow the bus. Resolves once the list is in. */
  start(): Promise<void>;
  stop(): void;
  flush(): void;

  /** Keep a session's transcript live and read its newest page and pending cards. */
  open(sessionID: string): Promise<void>;
  loadOlder(sessionID: string): Promise<void>;
  /** Show the prompt now and send it; rejects (after any rollback) if the send fails. */
  prompt(
    sessionID: string,
    text: string,
    options?: {
      model?: ModelRef;
      /** The row's `msg_*` id, when the caller needs it up front (scroll anchoring). */
      id?: string;
      files?: readonly PromptFile[];
    },
  ): Promise<void>;
  /** Create a session and add it to the list right away. */
  createSession(options: {
    directory: string;
    model?: ModelRef;
  }): Promise<SessionInfo>;
  replyPermission(
    request: PermissionRequest,
    decision: "once" | "always" | "reject",
  ): Promise<void>;
  replyForm(form: FormInfo, answer: FormAnswer): Promise<void>;
  cancelForm(form: FormInfo): Promise<void>;
}

export function createOcStore({
  client,
  pageSize = 60,
  keepTranscripts = 4,
  settleMs = 150,
  frameMs = 16,
  onError = (scope, error) => console.warn(`[oc-store] ${scope}:`, error),
}: OcStoreOptions): OcStore {
  const status = createAtom<{ status: ConnectionStatus; error: string | null }>(
    {
      status: "idle",
      error: null,
    },
  );
  const session = {
    info: createAtom<Records<SessionInfo>>({}),
    active: createAtom<Records<SessionStatus>>({}),
    message: createAtom<Records<TranscriptRows>>({}),
    permission: createAtom<Records<readonly PermissionRequest[]>>({}),
    form: createAtom<Records<readonly FormInfo[]>>({}),
    paging: createAtom<Records<Paging>>({}),
  };
  const replying = createAtom<Records<true>>({});

  const rootSessions = createAtom(() =>
    Object.values(session.info.get())
      .filter((s) => s.parentID === undefined)
      .sort((a, b) => b.time.updated - a.time.updated),
  );
  const running = createAtom<ReadonlySet<string>>(() => {
    const active = session.active.get();
    return new Set(
      Object.keys(active).filter((id) => active[id] === "running"),
    );
  });

  // ---- staged writes ----

  const staged: (() => void)[] = [];
  let frame: ReturnType<typeof setTimeout> | undefined;

  function stage(update: () => void): void {
    staged.push(update);
    frame ??= setTimeout(flush, frameMs);
  }

  function flush(): void {
    if (frame !== undefined) clearTimeout(frame);
    frame = undefined;
    if (staged.length === 0) return;
    const updates = staged.splice(0);
    batch(() => {
      for (const update of updates) update();
    });
  }

  // ---- transcripts ----

  const recent: string[] = [];

  const hasMessages = (sessionID: string) => sessionID in session.message.get();

  function updateMessages(
    sessionID: string,
    fn: (rows: TranscriptRows) => TranscriptRows,
  ): void {
    stage(() =>
      session.message.set((all) =>
        put(all, sessionID, fn(all[sessionID] ?? [])),
      ),
    );
  }

  function setPaging(sessionID: string, patch: Partial<Paging>): void {
    stage(() =>
      session.paging.set((all) => {
        const current = all[sessionID] ?? {
          cursor: undefined,
          hydrated: false,
          loadingOlder: false,
        };
        return put(all, sessionID, { ...current, ...patch });
      }),
    );
  }

  /** Keep a session's transcript (it folds events from now on); forget the oldest. */
  function holdMessages(sessionID: string): void {
    const at = recent.indexOf(sessionID);
    if (at >= 0) recent.splice(at, 1);
    recent.push(sessionID);
    if (!hasMessages(sessionID)) updateMessages(sessionID, (rows) => rows);
    while (recent.length > keepTranscripts) {
      const old = recent.shift() as string;
      stage(() => {
        session.message.set((all) => drop(all, old));
        session.paging.set((all) => drop(all, old));
      });
    }
    flush();
  }

  /** Re-read the newest page and merge it over the live rows. */
  async function refreshTail(sessionID: string): Promise<void> {
    try {
      const page = await client.listMessages(sessionID, { limit: pageSize });
      if (!hasMessages(sessionID)) return;
      const fetched = page.messages.slice().reverse();
      updateMessages(sessionID, (rows) => mergeProjection(rows, fetched));
    } catch (error) {
      onError("refresh", error);
    }
  }

  const settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  function settle(sessionID: string): void {
    const pending = settleTimers.get(sessionID);
    if (pending !== undefined) clearTimeout(pending);
    settleTimers.set(
      sessionID,
      setTimeout(() => {
        settleTimers.delete(sessionID);
        void refreshTail(sessionID);
      }, settleMs),
    );
  }

  // ---- optimistic prompts ----

  /** Ids of rows we added that the server has not echoed yet. */
  const outbox = new Set<string>();
  /** Per-session send chain: sends go out in submission order. */
  const sending = new Map<string, Promise<unknown>>();

  function sendInOrder<T>(
    sessionID: string,
    send: () => Promise<T>,
  ): Promise<T> {
    const request = (sending.get(sessionID) ?? Promise.resolve()).then(send);
    const tail = request.catch(() => undefined);
    sending.set(sessionID, tail);
    void tail.then(() => {
      if (sending.get(sessionID) === tail) sending.delete(sessionID);
    });
    return request;
  }

  /** Show `row` now. False for a retry of an id already on screen, which must never roll back. */
  function admit(sessionID: string, row: SessionMessageInfo): boolean {
    flush();
    if ((session.message.get()[sessionID] ?? []).some((r) => r.id === row.id))
      return false;
    outbox.add(row.id);
    updateMessages(sessionID, (rows) => [...rows, row]);
    flush();
    return true;
  }

  /** The send failed: take back a row this call added, unless the echo beat us. */
  function rollback(sessionID: string, id: string): void {
    if (!outbox.delete(id)) return;
    updateMessages(sessionID, (rows) => rows.filter((r) => r.id !== id));
    flush();
  }

  // ---- the bus ----

  async function loadSessions(): Promise<void> {
    const [page, active] = await Promise.all([
      client.listSessions({ limit: 100 }),
      client.activeSessionIDs(),
    ]);
    stage(() => {
      session.info.set(() =>
        Object.fromEntries(page.sessions.map((s) => [s.id, s])),
      );
      session.active.set(() =>
        Object.fromEntries([...active].map((id) => [id, "running" as const])),
      );
    });
    flush();
  }

  /** A session the bus announced: read the full row, as createData does. */
  async function syncSession(sessionID: string): Promise<void> {
    try {
      const info = await client.getSession(sessionID);
      stage(() => session.info.set((all) => put(all, info.id, info)));
    } catch (error) {
      onError("session", error);
    }
  }

  async function resync(): Promise<void> {
    try {
      await loadSessions();
    } catch (error) {
      onError("resync", error);
    }
    for (const sessionID of recent) void refreshTail(sessionID);
  }

  function onEvent(event: OcEvent): void {
    switch (event.type) {
      case "server.connected":
        // The first one belongs to the connection `start()` already read.
        if (skipConnected) skipConnected = false;
        else void resync();
        return;
      case "session.created":
        void syncSession(event.data.sessionID);
        return;
      case "session.deleted": {
        const id = event.data.sessionID;
        stage(() => {
          session.info.set((all) => drop(all, id));
          session.active.set((all) => drop(all, id));
        });
        return;
      }
      case "permission.asked": {
        const request = event.data as PermissionRequest;
        stage(() =>
          session.permission.set((all) =>
            upsertIn(all, request.sessionID, request),
          ),
        );
        return;
      }
      case "permission.replied": {
        const id = event.data.requestID;
        stage(() => session.permission.set((all) => removeIn(all, id)));
        return;
      }
      case "form.created": {
        const form = event.data.form as FormInfo;
        stage(() =>
          session.form.set((all) => upsertIn(all, form.sessionID, form)),
        );
        return;
      }
      case "form.replied":
      case "form.cancelled": {
        const id = event.data.id;
        stage(() => session.form.set((all) => removeIn(all, id)));
        return;
      }
    }

    const sessionID = sessionIDOf(event);
    if (sessionID === undefined) return;

    stage(() =>
      session.info.set((all) => {
        const info = all[sessionID];
        return info ? put(all, sessionID, applySessionEvent(info, event)) : all;
      }),
    );
    const next = statusFromEvent(event);
    if (next !== undefined)
      stage(() => session.active.set((all) => put(all, sessionID, next)));

    // The echo of an input makes it server state: no longer ours to roll back.
    if (
      event.type === "session.inbox.enqueued" ||
      event.type === "session.inbox.cancelled"
    ) {
      outbox.delete(event.data.inboxID);
    }
    if (!hasMessages(sessionID)) return;
    if (STREAMING_EVENT_TYPES.has(event.type)) {
      updateMessages(sessionID, (rows) => applyTranscriptEvent(rows, event));
      return;
    }
    if (
      TURN_END_EVENT_TYPES.has(event.type) ||
      event.type.startsWith("session.compaction.")
    ) {
      settle(sessionID);
    }
  }

  let events: AbortController | null = null;
  let skipConnected = true;

  async function start(): Promise<void> {
    if (events !== null) return;
    events = new AbortController();
    skipConnected = true;
    status.set({ status: "connecting", error: null });
    void subscribeEvents(client, onEvent, {
      signal: events.signal,
      onError: (error) => onError("bus", error),
    });
    try {
      await loadSessions();
      status.set({ status: "ready", error: null });
    } catch (error) {
      // Drop the bus too, so the next start() tries again from scratch.
      events.abort();
      events = null;
      status.set({ status: "error", error: String(error) });
      throw error;
    }
  }

  function stop(): void {
    events?.abort();
    events = null;
    for (const timer of settleTimers.values()) clearTimeout(timer);
    settleTimers.clear();
    status.set({ status: "idle", error: null });
  }

  // ---- reads ----

  /**
   * Permission requests and questions that were already waiting before we
   * subscribed. Both reads are session-scoped, so they load no new location.
   */
  async function loadPending(sessionID: string): Promise<void> {
    try {
      const [forms, permissions] = await Promise.all([
        client.raw.session.form.list({ sessionID }),
        client.raw.permission.list({ sessionID }),
      ]);
      const mine = (permissions as PermissionRequest[]).filter(
        (p) => p.sessionID === sessionID,
      );
      stage(() => {
        session.form.set((all) => put(all, sessionID, forms as FormInfo[]));
        session.permission.set((all) => put(all, sessionID, mine));
      });
    } catch (error) {
      onError("pending", error);
    }
  }

  /** Opens in flight, so a second open of the same session (a remount, a
   *  StrictMode double effect) shares the first one's reads. */
  const opening = new Map<string, Promise<void>>();

  function open(sessionID: string): Promise<void> {
    const pending = opening.get(sessionID);
    if (pending !== undefined) return pending;
    const run = openNow(sessionID).finally(() => opening.delete(sessionID));
    opening.set(sessionID, run);
    return run;
  }

  async function openNow(sessionID: string): Promise<void> {
    const warm = hasMessages(sessionID);
    // Hold it now so events fold into it while the first page loads.
    holdMessages(sessionID);
    void loadPending(sessionID);
    if (warm) {
      await refreshTail(sessionID);
      return;
    }
    try {
      const page = await client.listMessages(sessionID, { limit: pageSize });
      const fetched = page.messages.slice().reverse();
      updateMessages(sessionID, (rows) => mergeProjection(fetched, rows));
      setPaging(sessionID, { cursor: page.nextCursor, hydrated: true });
    } catch (error) {
      onError("open", error);
      setPaging(sessionID, { hydrated: true });
    }
    flush();
  }

  async function loadOlder(sessionID: string): Promise<void> {
    const paging = session.paging.get()[sessionID];
    const cursor = paging?.cursor;
    if (cursor === undefined || paging?.loadingOlder) return;
    setPaging(sessionID, { loadingOlder: true });
    flush();
    try {
      const page = await client.listMessages(sessionID, {
        cursor,
        limit: pageSize,
      });
      updateMessages(sessionID, (rows) => {
        const present = new Set(rows.map((r) => r.id));
        return [
          ...page.messages.filter((m) => !present.has(m.id)).reverse(),
          ...rows,
        ];
      });
      setPaging(sessionID, { cursor: page.nextCursor, loadingOlder: false });
    } catch (error) {
      onError("older", error);
      setPaging(sessionID, { loadingOlder: false });
    }
    // Rows and cursor land in one commit.
    flush();
  }

  // ---- writes ----

  async function prompt(
    sessionID: string,
    text: string,
    options?: { model?: ModelRef; id?: string; files?: readonly PromptFile[] },
  ) {
    const id = options?.id ?? mintMessageId();
    const files = options?.files ?? [];
    const row = {
      id,
      type: "user",
      text,
      // Inline images show at once, as the service will store them.
      ...(files.length > 0 ? { files: files.flatMap(inlineFile) } : {}),
      time: { created: Date.now() },
    } as SessionMessageInfo;
    const fresh = admit(sessionID, row);
    try {
      await sendInOrder(sessionID, async () => {
        // A model switch rides in the same slot, so it lands before the text.
        const model = options?.model;
        const current = session.info.get()[sessionID]?.model;
        if (
          model !== undefined &&
          (current === undefined ||
            formatModelRef(current.providerID, current.id) !==
              formatModelRef(model.providerID, model.id))
        ) {
          await client.switchModel(sessionID, model);
        }
        await client.prompt(sessionID, text, { id, files });
      });
    } catch (error) {
      if (fresh) rollback(sessionID, id);
      throw error;
    }
  }

  async function createSession(options: {
    directory: string;
    model?: ModelRef;
  }) {
    const info = await client.createSession(options);
    stage(() => session.info.set((all) => put(all, info.id, info)));
    holdMessages(info.id);
    setPaging(info.id, { hydrated: true });
    flush();
    return info;
  }

  /**
   * Answer a permission request or a form the way opencode desktop does: the
   * card stays (the UI disables it through `replying`) until the service has
   * the answer, and goes only then. "Not found" or "already settled" means
   * someone answered first, which is the same outcome. Any other failure
   * keeps the card and rejects.
   */
  async function answer(
    id: string,
    send: () => Promise<unknown>,
    settled: (error: unknown) => boolean,
    remove: () => void,
  ): Promise<void> {
    if (replying.get()[id]) return;
    replying.set((all) => put(all, id, true as const));
    try {
      await send();
    } catch (error) {
      if (!settled(error)) throw error;
    } finally {
      replying.set((all) => drop(all, id));
    }
    stage(remove);
    flush();
  }

  const formSettled = (error: unknown) =>
    isFormNotFoundError(error) || isFormAlreadySettledError(error);

  return {
    client,
    status,
    session,
    replying,
    rootSessions,
    running,
    start,
    stop,
    flush,
    open,
    loadOlder,
    prompt,
    createSession,
    replyPermission: (request, decision) =>
      answer(
        request.id,
        () => client.replyPermission(request.sessionID, request.id, decision),
        isPermissionNotFoundError,
        () => session.permission.set((all) => removeIn(all, request.id)),
      ),
    replyForm: (form, value) =>
      answer(
        form.id,
        () =>
          client.raw.session.form.reply({
            sessionID: form.sessionID,
            formID: form.id,
            answer: value,
          }),
        formSettled,
        () => session.form.set((all) => removeIn(all, form.id)),
      ),
    cancelForm: (form) =>
      answer(
        form.id,
        () =>
          client.raw.session.form.cancel({
            sessionID: form.sessionID,
            formID: form.id,
          }),
        formSettled,
        () => session.form.set((all) => removeIn(all, form.id)),
      ),
  };
}

/** A `data:` URI file as the service stores it on the user message. */
function inlineFile(file: PromptFile) {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(file.uri);
  if (match === null) return [];
  return [
    {
      data: match[2] as string,
      mime: match[1] as string,
      source: { type: "inline" as const },
      ...(file.name !== undefined ? { name: file.name } : {}),
    },
  ];
}
