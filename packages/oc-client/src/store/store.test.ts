/**
 * Store tests over a fake `OcClient`: a push-driven event stream
 * (`server.connected` first, like the real bus), projection pages, and the
 * session list. Covers the list and busy flags, transcript hydration and
 * paging, live folding and the turn-end re-read, optimistic prompts, staged
 * writes, and answering permission requests.
 */

import type { PermissionRequest } from "@opencode/client";
import { afterEach, describe, expect, it } from "vitest";
import type { OcClient, SessionInfo, SessionMessageInfo } from "../client.ts";
import type { OcEvent } from "../events.ts";
import { visibleMessages } from "../transcript-reducer.ts";
import { createOcStore, isUnread, type OcStore } from "./store.ts";

const SES = "ses_a";

class FakeBus {
  private queue: OcEvent[] = [];
  private wake: (() => void) | null = null;
  private closeWake: (() => void) | null = null;
  connections = 0;

  push(event: OcEvent): void {
    this.queue.push(event);
    this.wake?.();
    this.wake = null;
  }

  /** End the current stream (server restart); the next subscribe reconnects. */
  close(): void {
    this.closeWake?.();
    this.closeWake = null;
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<OcEvent> {
    this.connections += 1;
    yield ev("server.connected", {});
    let closed = false;
    while (!signal.aborted && !closed) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
          this.closeWake = () => {
            closed = true;
            resolve();
          };
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        continue;
      }
      yield this.queue.shift() as OcEvent;
    }
  }
}

function ev(
  type: string,
  data: Record<string, unknown>,
  created = Date.now(),
): OcEvent {
  return {
    type,
    id: `evt_${Math.random().toString(36).slice(2, 10)}`,
    created,
    data,
    durable: { seq: 1 },
  } as unknown as OcEvent;
}

const enqueued = (id: string, text: string, created: number) =>
  ev(
    "session.inbox.enqueued",
    {
      sessionID: SES,
      inboxID: id,
      item: { type: "user", payload: { text }, delivery: "steer" },
    },
    created,
  );

function user(id: string, text: string, created: number): SessionMessageInfo {
  return { id, type: "user", text, time: { created } };
}

function info(id: string, title: string, updated: number): SessionInfo {
  return {
    id,
    projectID: "p",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated },
    title,
    location: { directory: `/tmp/${id}` },
  } as SessionInfo;
}

function fakeClient(opts: {
  bus: FakeBus;
  pages?: Array<{ messages: SessionMessageInfo[]; nextCursor?: string }>;
  sessions?: Array<{ sessions: SessionInfo[]; nextCursor?: string }>;
  active?: string[];
  prompt?: (text: string) => Promise<void>;
  replyPermission?: () => Promise<void>;
  /** null = the default can't be read. */
  defaultModel?: { providerID: string; id: string } | null;
  /** Subagent sessions' parents, for `getSession`. */
  parents?: Record<string, string>;
  /** Rows `getSession` returns, by id (after a turn ends, say). */
  rows?: Record<string, SessionInfo>;
}) {
  const messageCalls: Array<{ cursor?: string }> = [];
  const listCalls: number[] = [];
  const prompts: Array<{ id?: string; text: string }> = [];
  const switches: string[] = [];
  const created: Array<{ model?: { providerID: string; id: string } }> = [];
  /** Revert-path calls, in order. */
  const calls: string[] = [];
  const views: Array<{ sessionID: string; idle: number }> = [];
  const client = {
    async interrupt() {
      calls.push("interrupt");
    },
    async wait() {
      calls.push("wait");
    },
    async revert(_sessionID: string, messageID: string) {
      calls.push(`revert ${messageID}`);
      return { messageID };
    },
    async unrevert() {
      calls.push("unrevert");
    },
    async fork(_sessionID: string, before: string) {
      calls.push(`fork ${before}`);
      return info("ses_fork", "fork", 60);
    },
    events: ({ signal }: { signal: AbortSignal }) => opts.bus.iterate(signal),
    async listMessages(
      _sessionID: string,
      o: { limit?: number; cursor?: string } = {},
    ) {
      messageCalls.push(o);
      return opts.pages?.shift() ?? { messages: [] };
    },
    async listSessions() {
      listCalls.push(Date.now());
      return opts.sessions?.shift() ?? { sessions: [] };
    },
    async getSession(id: string) {
      const row = opts.rows?.[id] ?? info(id, "created", 50);
      const parentID = opts.parents?.[id];
      return parentID === undefined ? row : { ...row, parentID };
    },
    async createSession(o: { model?: { providerID: string; id: string } }) {
      created.push(o);
      return info(SES, "created", 50);
    },
    async defaultModel() {
      return opts.defaultModel === null
        ? Promise.reject(new Error("no default"))
        : (opts.defaultModel ?? { providerID: "opencode", id: "flint" });
    },
    async activeSessionIDs() {
      return new Set(opts.active ?? []);
    },
    async switchModel(
      _sessionID: string,
      model: { providerID: string; id: string },
    ) {
      switches.push(`${model.providerID}/${model.id}`);
    },
    async prompt(_sessionID: string, text: string, o: { id?: string } = {}) {
      prompts.push({ id: o.id, text });
      await opts.prompt?.(text);
    },
    async replyPermission() {
      await opts.replyPermission?.();
    },
    raw: {
      session: {
        form: { list: async () => [] },
        view: async (input: { sessionID: string; idle: number }) => {
          views.push(input);
        },
      },
      permission: { list: async () => [] },
    },
  };
  return {
    client: client as unknown as OcClient,
    messageCalls,
    listCalls,
    prompts,
    switches,
    created,
    calls,
    views,
  };
}

const made: OcStore[] = [];
function store(client: OcClient): OcStore {
  const s = createOcStore({
    client,
    pageSize: 2,
    settleMs: 5,
    frameMs: 1,
    onError: () => {},
  });
  made.push(s);
  return s;
}
afterEach(() => {
  for (const s of made.splice(0)) s.stop();
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const ids = (s: OcStore) =>
  (s.session.message.get()[SES] ?? []).map((r) => r.id);

describe("session list", () => {
  it("lists, seeds busy flags from the active snapshot, and patches from the bus", async () => {
    const bus = new FakeBus();
    const { client } = fakeClient({
      bus,
      sessions: [
        { sessions: [info("ses_old", "old", 10), info(SES, "a", 20)] },
      ],
      active: ["ses_old"],
    });
    const s = store(client);
    await s.start();
    expect(s.status.get().status).toBe("ready");
    expect(s.rootSessions.get().map((x) => x.id)).toEqual([SES, "ses_old"]);
    expect([...s.running.get()]).toEqual(["ses_old"]);

    bus.push(ev("session.renamed", { sessionID: SES, title: "renamed" }));
    bus.push(ev("session.execution.started", { sessionID: SES }));
    bus.push(ev("session.created", { sessionID: "ses_new" }));
    bus.push(ev("session.deleted", { sessionID: "ses_old" }));
    await tick();
    s.flush();
    expect(s.session.info.get()[SES]?.title).toBe("renamed");
    expect(s.running.get().has(SES)).toBe(true);
    expect(s.session.info.get().ses_new?.title).toBe("created");
    expect(s.session.info.get().ses_old).toBeUndefined();
  });

  it("drops a session from the list when it's archived, and back when not", async () => {
    const bus = new FakeBus();
    const { client } = fakeClient({
      bus,
      sessions: [
        { sessions: [info("ses_old", "old", 10), info(SES, "a", 20)] },
      ],
    });
    const s = store(client);
    await s.start();
    bus.push(ev("session.archived", { sessionID: SES }));
    await tick();
    s.flush();
    expect(s.rootSessions.get().map((x) => x.id)).toEqual(["ses_old"]);
    bus.push(ev("session.unarchived", { sessionID: SES }));
    await tick();
    s.flush();
    expect(s.rootSessions.get().map((x) => x.id)).toEqual([SES, "ses_old"]);
  });

  it("re-reads the list on reconnect, not on the first connect", {
    timeout: 5000,
  }, async () => {
    const bus = new FakeBus();
    const { client, listCalls } = fakeClient({ bus });
    const s = store(client);
    await s.start();
    await tick();
    expect(listCalls).toHaveLength(1);
    bus.close();
    // subscribeEvents waits 1 s before it reconnects.
    await tick(1200);
    expect(bus.connections).toBeGreaterThan(1);
    expect(listCalls.length).toBeGreaterThan(1);
  });
});

describe("transcripts", () => {
  it("hydrates from the newest page and prepends older pages on demand", async () => {
    const bus = new FakeBus();
    const { client, messageCalls } = fakeClient({
      bus,
      pages: [
        {
          messages: [user("msg_4", "d", 4), user("msg_3", "c", 3)],
          nextCursor: "c1",
        },
        { messages: [user("msg_2", "b", 2), user("msg_1", "a", 1)] },
      ],
    });
    const s = store(client);
    await s.start();
    await s.open(SES);
    expect(ids(s)).toEqual(["msg_3", "msg_4"]);
    expect(s.session.paging.get()[SES]).toMatchObject({
      cursor: "c1",
      hydrated: true,
    });

    await s.loadOlder(SES);
    expect(messageCalls.at(-1)?.cursor).toBe("c1");
    expect(ids(s)).toEqual(["msg_1", "msg_2", "msg_3", "msg_4"]);
    expect(s.session.paging.get()[SES]?.cursor).toBeUndefined();
  });

  it("folds streaming events live, then re-reads the tail when the turn ends", async () => {
    const bus = new FakeBus();
    const { client, messageCalls } = fakeClient({
      bus,
      pages: [
        { messages: [] },
        { messages: [user("msg_1", "server copy", 1)] },
      ],
    });
    const s = store(client);
    await s.start();
    await s.open(SES);
    bus.push(enqueued("msg_1", "hi", 1));
    await tick();
    s.flush();
    expect(ids(s)).toEqual(["msg_1"]);

    bus.push(ev("session.execution.succeeded", { sessionID: SES }));
    await tick(40);
    s.flush();
    expect(messageCalls).toHaveLength(2);
    expect(s.session.message.get()[SES]?.[0]).toMatchObject({
      text: "server copy",
    });
  });

  it("a second open while the first is reading shares its reads", async () => {
    const bus = new FakeBus();
    const { client, messageCalls } = fakeClient({ bus });
    const s = store(client);
    await s.start();
    await Promise.all([s.open(SES), s.open(SES)]);
    expect(messageCalls).toHaveLength(1);
  });

  it("keeps a few transcripts and forgets the oldest", async () => {
    const bus = new FakeBus();
    const { client } = fakeClient({ bus });
    const s = createOcStore({
      client,
      keepTranscripts: 2,
      frameMs: 1,
      onError: () => {},
    });
    made.push(s);
    await s.start();
    await s.open("ses_1");
    await s.open("ses_2");
    await s.open("ses_3");
    expect(Object.keys(s.session.message.get()).sort()).toEqual([
      "ses_2",
      "ses_3",
    ]);
  });
});

describe("optimistic prompts", () => {
  it("shows at once; the echo replaces the guess in place", async () => {
    const bus = new FakeBus();
    const { client, prompts } = fakeClient({ bus });
    const s = store(client);
    await s.start();
    await s.open(SES);
    const sent = s.prompt(SES, "hi");
    expect(ids(s)).toHaveLength(1);
    await sent;
    const id = prompts[0]?.id as string;
    expect(ids(s)).toEqual([id]);

    bus.push(enqueued(id, "hi", 9));
    await tick();
    s.flush();
    expect(ids(s)).toEqual([id]);
    expect(s.session.message.get()[SES]?.[0]?.time.created).toBe(9);
  });

  it("shows an inline image on the guess, as the service will store it", async () => {
    const bus = new FakeBus();
    const { client } = fakeClient({ bus });
    const s = store(client);
    await s.start();
    await s.open(SES);
    await s.prompt(SES, "look", {
      files: [{ uri: "data:image/png;base64,AAAA", name: "a.png" }],
    });
    const row = s.session.message.get()[SES]?.[0];
    expect(row?.type === "user" ? row.files : undefined).toEqual([
      {
        data: "AAAA",
        mime: "image/png",
        source: { type: "inline" },
        name: "a.png",
      },
    ]);
  });

  it("a failed send takes the row back, unless the echo arrived first", async () => {
    const bus = new FakeBus();
    let echoFirst = false;
    const { client, prompts } = fakeClient({
      bus,
      prompt: async (text) => {
        if (echoFirst) {
          bus.push(enqueued(prompts.at(-1)?.id as string, text, 5));
          await tick();
        }
        throw new Error("boom");
      },
    });
    const s = store(client);
    await s.start();
    await s.open(SES);
    await expect(s.prompt(SES, "lost")).rejects.toThrow("boom");
    expect(ids(s)).toEqual([]);

    echoFirst = true;
    await expect(s.prompt(SES, "kept")).rejects.toThrow("boom");
    s.flush();
    expect(ids(s)).toEqual([prompts.at(-1)?.id]);
  });

  it("sends in submission order, with a model switch ahead of its text", async () => {
    const bus = new FakeBus();
    const order: string[] = [];
    const { client, switches } = fakeClient({
      bus,
      sessions: [{ sessions: [info(SES, "a", 1)] }],
      prompt: async (text) => {
        if (text === "first") await tick(20);
        order.push(text);
      },
    });
    const s = store(client);
    await s.start();
    await s.open(SES);
    await Promise.all([
      s.prompt(SES, "first"),
      s.prompt(SES, "second", { model: { providerID: "p", id: "m" } }),
    ]);
    expect(order).toEqual(["first", "second"]);
    expect(switches).toEqual(["p/m"]);
  });
});

describe("staged writes", () => {
  it("one frame of bus events reaches subscribers once", async () => {
    const bus = new FakeBus();
    const { client } = fakeClient({
      bus,
      sessions: [{ sessions: [info(SES, "a", 1)] }],
    });
    const s = createOcStore({ client, frameMs: 10, onError: () => {} });
    made.push(s);
    await s.start();
    let heard = 0;
    const sub = s.session.info.subscribe(() => heard++);
    bus.push(ev("session.renamed", { sessionID: SES, title: "b" }));
    bus.push(ev("session.renamed", { sessionID: SES, title: "c" }));
    await tick(40);
    expect(s.session.info.get()[SES]?.title).toBe("c");
    expect(heard).toBe(1);
    sub.unsubscribe();
  });
});

describe("permission requests", () => {
  const request = { id: "per_1", sessionID: SES } as PermissionRequest;

  it("stay until the server has the answer; not found counts as answered", async () => {
    const bus = new FakeBus();
    let release: () => void = () => {};
    const { client } = fakeClient({
      bus,
      replyPermission: () =>
        new Promise((_, reject) => {
          release = () => reject({ _tag: "PermissionNotFoundError" });
        }),
    });
    const s = store(client);
    await s.start();
    bus.push(
      ev("permission.asked", request as unknown as Record<string, unknown>),
    );
    await tick();
    s.flush();
    expect(s.session.permission.get()[SES]).toHaveLength(1);

    const reply = s.replyPermission(request, "once");
    expect(s.replying.get().per_1).toBe(true);
    expect(s.session.permission.get()[SES]).toHaveLength(1);
    release();
    await reply;
    expect(s.replying.get().per_1).toBeUndefined();
    expect(s.session.permission.get()[SES]).toBeUndefined();
  });

  it("any other failure keeps the card and rejects", async () => {
    const bus = new FakeBus();
    const { client } = fakeClient({
      bus,
      replyPermission: async () => {
        throw new Error("offline");
      },
    });
    const s = store(client);
    await s.start();
    bus.push(
      ev("permission.asked", request as unknown as Record<string, unknown>),
    );
    await tick();
    await expect(s.replyPermission(request, "reject")).rejects.toThrow(
      "offline",
    );
    s.flush();
    expect(s.session.permission.get()[SES]).toHaveLength(1);
    expect(s.replying.get().per_1).toBeUndefined();
  });
});

describe("createSession", () => {
  it("pins the default model when none is picked", async () => {
    const fake = fakeClient({ bus: new FakeBus() });
    await store(fake.client).createSession({ directory: "/tmp/x" });
    expect(fake.created[0]?.model).toEqual({
      providerID: "opencode",
      id: "flint",
    });
  });

  it("keeps a picked model", async () => {
    const fake = fakeClient({ bus: new FakeBus() });
    const model = { providerID: "opencode-go", id: "deepseek-v4.1-flash" };
    await store(fake.client).createSession({ directory: "/tmp/x", model });
    expect(fake.created[0]?.model).toEqual(model);
  });

  it("prefers the model of the most recently active session", async () => {
    const withModel = (id: string, updated: number, model?: string) =>
      ({
        ...info(id, id, updated),
        ...(model && {
          model: { providerID: "opencode-go", id: model, variant: "max" },
        }),
      }) as SessionInfo;
    const fake = fakeClient({
      bus: new FakeBus(),
      sessions: [
        {
          sessions: [
            withModel("ses_old", 1, "glm-5.3"),
            withModel("ses_new", 3, "deepseek-v4.1-flash"),
            withModel("ses_unpinned", 5),
          ],
        },
      ],
    });
    const s = store(fake.client);
    await s.start();
    // The reasoning variant comes along with the model.
    const used = {
      providerID: "opencode-go",
      id: "deepseek-v4.1-flash",
      variant: "max",
    };
    expect(s.lastUsedModel.get()).toEqual(used);
    await s.createSession({ directory: "/tmp/x" });
    expect(fake.created[0]?.model).toEqual(used);
  });

  it("leaves the pick to the service when the default can't be read", async () => {
    const fake = fakeClient({ bus: new FakeBus(), defaultModel: null });
    await store(fake.client).createSession({ directory: "/tmp/x" });
    expect(fake.created[0]?.model).toBeUndefined();
  });
});

describe("reverts", () => {
  const history = [
    user("msg_1", "a", 1),
    user("msg_2", "b", 2),
    user("msg_3", "c", 3),
  ];
  const visible = (s: OcStore) =>
    visibleMessages(
      s.session.message.get()[SES] ?? [],
      s.session.info.get()[SES]?.revert,
    ).map((r) => r.id);

  async function opened(prompt?: () => Promise<void>) {
    const bus = new FakeBus();
    const fake = fakeClient({
      bus,
      sessions: [{ sessions: [info(SES, "a", 20)] }],
      // Opening reads one page; a re-read after a failed send, the next.
      pages: [
        { messages: history.slice().reverse() },
        { messages: history.slice().reverse() },
      ],
      ...(prompt ? { prompt } : {}),
    });
    const s = store(fake.client);
    await s.start();
    await s.open(SES);
    return { s, bus, ...fake };
  }

  it("stops the turn, then hides the message and what follows", async () => {
    const { s, calls } = await opened();
    await s.revert(SES, "msg_2");
    expect(calls).toEqual(["interrupt", "wait", "revert msg_2"]);
    expect(visible(s)).toEqual(["msg_1"]);
    expect(ids(s)).toEqual(["msg_1", "msg_2", "msg_3"]);

    await s.unrevert(SES);
    expect(visible(s)).toEqual(["msg_1", "msg_2", "msg_3"]);
  });

  it("a prompt drops the hidden messages and shows at once", async () => {
    const { s } = await opened();
    await s.revert(SES, "msg_2");
    await s.prompt(SES, "again", { id: "msg_4" });
    expect(s.session.info.get()[SES]?.revert).toBeUndefined();
    expect(visible(s)).toEqual(["msg_1", "msg_4"]);
  });

  it("a failed prompt brings the revert back from the service", async () => {
    const { s } = await opened(() => Promise.reject(new Error("down")));
    await s.revert(SES, "msg_2");
    await expect(s.prompt(SES, "again", { id: "msg_4" })).rejects.toThrow();
    // getSession has no revert in the fake; the re-read is what counts.
    await tick();
    s.flush();
    expect(ids(s)).toEqual(["msg_1", "msg_2", "msg_3"]);
  });

  it("follows another client's revert and its commit", async () => {
    const { s, bus } = await opened();
    bus.push(
      ev("session.revert.staged", {
        sessionID: SES,
        revert: { messageID: "msg_3" },
      }),
    );
    await tick();
    s.flush();
    expect(visible(s)).toEqual(["msg_1", "msg_2"]);

    bus.push(ev("session.revert.committed", { sessionID: SES, to: "msg_3" }));
    await tick();
    s.flush();
    expect(s.session.info.get()[SES]?.revert).toBeUndefined();
    expect(ids(s)).toEqual(["msg_1", "msg_2"]);
  });

  it("forks into a new listed session", async () => {
    const { s, calls } = await opened();
    const forked = await s.fork(SES, "msg_2");
    expect(calls).toEqual(["fork msg_2"]);
    expect(s.session.info.get()[forked.id]).toBeDefined();
  });
});

describe("agent state", () => {
  it("files a subagent's request under the session that started it", async () => {
    const bus = new FakeBus();
    const { client } = fakeClient({
      bus,
      sessions: [{ sessions: [info(SES, "a", 20)] }],
      parents: { ses_child: SES },
    });
    const s = store(client);
    await s.start();
    const request = {
      id: "per_1",
      sessionID: "ses_child",
      action: "read",
      resources: [".env.local"],
    } as unknown as PermissionRequest;
    bus.push(
      ev("permission.asked", request as unknown as Record<string, unknown>),
    );
    await tick();
    s.flush();
    expect(s.pending.get()[SES]?.permissions.map((p) => p.id)).toEqual([
      "per_1",
    ]);
    // The child row is read for its parent, but stays out of the list.
    expect(s.rootSessions.get().map((x) => x.id)).toEqual([SES]);

    bus.push(
      ev("permission.replied", { sessionID: "ses_child", requestID: "per_1" }),
    );
    await tick();
    s.flush();
    expect(s.pending.get()[SES]).toBeUndefined();
  });

  it("flags a failed turn until the next one starts", async () => {
    const bus = new FakeBus();
    const { client } = fakeClient({
      bus,
      sessions: [{ sessions: [info(SES, "a", 20)] }],
    });
    const s = store(client);
    await s.start();
    bus.push(ev("session.execution.failed", { sessionID: SES, error: {} }));
    await tick();
    s.flush();
    expect(s.session.failed.get()[SES]).toBe(true);
    bus.push(ev("session.execution.started", { sessionID: SES }));
    await tick();
    s.flush();
    expect(s.session.failed.get()[SES]).toBeUndefined();
  });

  it("reads the row when a turn ends, and marks it viewed for every client", async () => {
    const bus = new FakeBus();
    const idleRow = {
      ...info(SES, "a", 30),
      time: { created: 1, updated: 30, idle: 30 },
    } as SessionInfo;
    const { client, views } = fakeClient({
      bus,
      sessions: [{ sessions: [info(SES, "a", 20)] }],
      rows: { [SES]: idleRow },
    });
    const s = store(client);
    await s.start();
    bus.push(ev("session.execution.succeeded", { sessionID: SES }));
    await tick();
    s.flush();
    const row = s.session.info.get()[SES] as SessionInfo;
    expect(row.time.idle).toBe(30);
    expect(isUnread(row)).toBe(true);
    // Turns from before the client tracked this don't count.
    expect(isUnread(row, 40)).toBe(false);

    s.markViewed(SES);
    expect(views).toEqual([{ sessionID: SES, idle: 30 }]);
    expect(isUnread(s.session.info.get()[SES] as SessionInfo)).toBe(false);
    s.markViewed(SES);
    expect(views).toHaveLength(1);
  });

  it("takes another client's view from the bus", async () => {
    const bus = new FakeBus();
    const row = {
      ...info(SES, "a", 30),
      time: { created: 1, updated: 30, idle: 30 },
    } as SessionInfo;
    const { client } = fakeClient({ bus, sessions: [{ sessions: [row] }] });
    const s = store(client);
    await s.start();
    expect(isUnread(s.session.info.get()[SES] as SessionInfo)).toBe(true);
    bus.push(ev("session.viewed", { sessionID: SES, idle: 30 }));
    await tick();
    s.flush();
    expect(isUnread(s.session.info.get()[SES] as SessionInfo)).toBe(false);
  });
});
