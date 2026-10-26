import { describe, expect, it } from "vitest";
import { parseClientFrame } from "./client-frame.ts";

describe("parseClientFrame", () => {
  it("accepts hello, ping and every command", () => {
    for (const frame of [
      { type: "hello", protocolVersion: "0.2.5" },
      { type: "ping", t: 0 },
      { type: "getGitStatus", requestId: "r", cwd: "/p" },
      { type: "subscribeGitStatus", requestId: "r", cwd: "/p" },
      { type: "unsubscribeGitStatus", requestId: "r", cwd: "/p" },
      { type: "getWorkingTreeDiff", requestId: "r", cwd: "/p" },
      { type: "listDirectory", requestId: "r", path: "~", includeFiles: true },
      { type: "getFilesystemRoots", requestId: "r" },
      { type: "getPreviews", requestId: "r", directory: "/p" },
      { type: "subscribePreviews", requestId: "r", directory: "/p" },
      { type: "unsubscribePreviews", requestId: "r", directory: "/p" },
      { type: "stopPreview", requestId: "r", directory: "/p", name: "web" },
      { type: "getForwardPorts", requestId: "r" },
      { type: "subscribeForwardPorts", requestId: "r" },
      { type: "unsubscribeForwardPorts", requestId: "r" },
    ])
      expect(parseClientFrame(frame)).toEqual(frame);
  });

  it("drops fields it does not know", () => {
    expect(parseClientFrame({ type: "ping", t: 1, extra: true })).toEqual({
      type: "ping",
      t: 1,
    });
  });

  it("rejects missing or mistyped fields, daemon-only frames and old commands", () => {
    for (const frame of [
      { type: "hello" },
      { type: "getGitStatus", requestId: "r" },
      { type: "getGitStatus", requestId: "r", cwd: 1 },
      { type: "listDirectory", requestId: "r", path: "~", includeFiles: "yes" },
      { type: "gitStatus", cwd: "/p", status: {} },
      { type: "sendPrompt", requestId: "r", sessionId: "s", text: "x" },
      null,
      "ping",
    ])
      expect(() => parseClientFrame(frame)).toThrow();
  });
});
