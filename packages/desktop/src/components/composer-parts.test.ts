import { describe, expect, it } from "vitest";
import {
  type Attachment,
  buildParts,
  fileUri,
  type Mention,
  parseSlash,
  plainText,
} from "./composer-parts";

describe("buildParts", () => {
  const mentions = new Map<string, Mention>([
    ["@src/a b.ts", { kind: "file", path: "src/a b.ts" }],
    ["@General", { kind: "agent", name: "General" }],
    ["@opencode", { kind: "skill", id: "opencode" }],
  ]);

  it("sends each picked mention with the span that names it", () => {
    const text = "read @src/a b.ts then ask @General";
    const parts = buildParts(text, mentions, "/repo", []);
    expect(parts.files).toEqual([
      {
        uri: "file:///repo/src/a%20b.ts",
        name: "a b.ts",
        mention: { start: 5, end: 16, text: "@src/a b.ts" },
      },
    ]);
    expect(parts.agents).toEqual([
      { name: "General", mention: { start: 26, end: 34, text: "@General" } },
    ]);
    expect(parts.skills).toEqual([]);
  });

  it("drops a mention edited out of the text or inside a longer word", () => {
    const parts = buildParts("ask @Generally", mentions, "/repo", []);
    expect(parts.agents).toEqual([]);
  });

  it("adds attachments inline after the mentions", () => {
    const image: Attachment = {
      id: "1",
      name: "shot.png",
      mime: "image/png",
      dataUrl: "data:image/png;base64,AAAA",
    };
    expect(buildParts("look", mentions, "/repo", [image]).files).toEqual([
      { uri: "data:image/png;base64,AAAA", name: "shot.png" },
    ]);
  });
});

describe("helpers", () => {
  it("keeps absolute paths and encodes each segment", () => {
    expect(fileUri("/repo/", "a#b/c.ts")).toBe("file:///repo/a%23b/c.ts");
    expect(fileUri("/repo", "/etc/hosts")).toBe("file:///etc/hosts");
  });

  it("parses a slash command and its arguments", () => {
    expect(parseSlash("/review  branch main ")).toEqual({
      name: "review",
      args: "branch main",
    });
    expect(parseSlash("/compact")).toEqual({ name: "compact", args: "" });
    expect(parseSlash("not /a command")).toBeNull();
  });

  it("turns the editor's no-break spaces into spaces", () => {
    expect(plainText("@a.ts next ")).toBe("@a.ts next");
  });
});
