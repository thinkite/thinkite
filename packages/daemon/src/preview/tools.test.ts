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
      "browser_open",
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

  it("ties server_start and browser_open together in their first lines", () => {
    expect(first("server_start")).toContain("not shell background/nohup");
    expect(first("server_start")).toContain("browser_open");
    expect(first("browser_open")).toContain("server_start");
  });

  it("asks browser_open for a URL", async () => {
    const open = tools.find((t) => t.name === "browser_open");
    expect(await open?.call({}, { directory: "/proj" })).toEqual({
      text: "url is required",
      isError: true,
    });
  });
});
