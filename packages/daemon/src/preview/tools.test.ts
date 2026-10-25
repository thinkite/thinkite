import { describe, expect, it } from "vitest";
import { PreviewRegistry } from "./registry.ts";
import type { ShellApi } from "./shells.ts";
import { previewTools } from "./tools.ts";

const tools = previewTools(new PreviewRegistry({ shells: {} as ShellApi }));

describe("preview tools", () => {
  it("are the three documented names", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "preview_open",
      "preview_list",
      "preview_stop",
    ]);
  });

  // opencode's Code Mode catalog shows only the first line of a description,
  // cut at 120 characters, and attached clients have no other channel.
  it.each(
    tools.map((t) => [t.name, t.description.split("\n")[0] ?? ""]),
  )("%s keeps its first line under 120 characters", (_name, first) => {
    expect(first.length).toBeLessThanOrEqual(120);
    expect(first.length).toBeGreaterThan(20);
  });

  it("tells the model where the shell ID comes from", () => {
    expect(tools[0]?.description.split("\n")[0]).toContain(
      "shell tool's background mode",
    );
  });

  it("asks for name, shell ID and URL", async () => {
    const outcome = await tools[0]?.call(
      { name: "web", url: "http://localhost:5173/" },
      { directory: "/proj" },
    );
    expect(outcome).toEqual({
      text: "name, shellID and url are required",
      isError: true,
    });
  });
});
