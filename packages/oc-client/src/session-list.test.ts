import { describe, expect, it } from "vitest";
import {
  applySessionListEvent,
  applySessionListPage,
  createInitialSessionListState,
} from "./session-list.ts";

const SES_A = {
  id: "ses_a",
  projectID: "p",
  agent: "build",
  model: { id: "m1", providerID: "prov" },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 100, updated: 300 },
  title: "Alpha",
  location: { directory: "/tmp/a" },
};

const SES_B = {
  ...SES_A,
  id: "ses_b",
  title: "Beta",
  time: { created: 100, updated: 200 },
  location: { directory: "/tmp/b" },
};

describe("oc session list", () => {
  it("merges pages sorted by updated desc", () => {
    let state = createInitialSessionListState();
    state = applySessionListPage(state, {
      sessions: [SES_B, SES_A],
      nextCursor: "c1",
    });
    expect(state.items.map((s) => s.id)).toEqual(["ses_a", "ses_b"]);
    expect(state.items[0]).toMatchObject({
      title: "Alpha",
      directory: "/tmp/a",
      model: { id: "m1", providerID: "prov" },
    });
    expect(state.nextCursor).toBe("c1");
  });

  it("upserts on created/updated and removes on deleted", () => {
    let state = createInitialSessionListState();
    state = applySessionListEvent(state, {
      type: "session.created",
      data: {
        sessionID: "ses_a",
        info: { ...SES_A, directory: "/tmp/a", time: SES_A.time },
      },
    });
    expect(state.items).toHaveLength(1);
    // Bus info uses the sibling Session shape (directory, not location).
    expect(state.items[0]?.directory).toBe("/tmp/a");

    state = applySessionListEvent(state, {
      type: "session.updated",
      data: {
        sessionID: "ses_a",
        info: {
          ...SES_A,
          directory: "/tmp/a",
          title: "Alpha 2",
          time: { created: 100, updated: 400 },
        },
      },
    });
    expect(state.items[0]?.title).toBe("Alpha 2");

    state = applySessionListEvent(state, {
      type: "session.deleted",
      data: { sessionID: "ses_a", info: { id: "ses_a" } },
    });
    expect(state.items).toHaveLength(0);
  });

  it("hides archived sessions", () => {
    let state = applySessionListPage(createInitialSessionListState(), {
      sessions: [SES_A, SES_B],
    });
    expect(state.items).toHaveLength(2);
    state = applySessionListEvent(state, {
      type: "session.updated",
      data: {
        sessionID: "ses_b",
        info: {
          ...SES_B,
          directory: "/tmp/b",
          time: { created: 100, updated: 500, archived: 500 },
        },
      },
    });
    expect(state.items.map((s) => s.id)).toEqual(["ses_a"]);
  });

  it("ignores unknown bus events", () => {
    const state = createInitialSessionListState();
    expect(
      applySessionListEvent(state, { type: "session.status", data: {} }),
    ).toBe(state);
  });
});
