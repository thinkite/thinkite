import { describe, expect, it } from "vitest";
import { PreviewRegistry } from "./registry.ts";
import type { ShellApi } from "./shells.ts";
import { previewTools } from "./tools.ts";

const tools = previewTools(new PreviewRegistry({ shells: {} as ShellApi }));
const first = (name: string) =>
  tools.find((t) => t.name === name)?.description.split("\n")[0] ?? "";

describe("preview tools", () => {
  it("are the documented names", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "server_start",
      "server_logs",
      "server_list",
      "server_stop",
    ]);
  });

  // opencode's Code Mode catalog shows only the first line of a description,
  // cut at 120 characters, and attached clients have no other channel.
  it.each(
    tools.map((t) => [t.name, t.description.split("\n")[0] ?? ""]),
  )("%s keeps its first line under 120 characters", (_name, line) => {
    expect(line.length).toBeLessThanOrEqual(120);
    expect(line.length).toBeGreaterThan(20);
  });

  it("tells the agent to show a page by writing its URL, not by a tool", () => {
    expect(first("server_start")).toContain("not shell background/nohup");
    expect(first("server_start")).toContain("write its URL in your reply");
  });

  it("asks server_logs for a name", async () => {
    const logs = tools.find((t) => t.name === "server_logs");
    expect(await logs?.call({}, { directory: "/proj" })).toEqual({
      text: "name is required",
      isError: true,
    });
  });
});
