import { describe, expect, it } from "vitest";
import { PreviewRegistry } from "./registry.ts";
import type { ShellApi } from "./shells.ts";
import { previewTools } from "./tools.ts";

const tools = previewTools(new PreviewRegistry({ shells: {} as ShellApi }));

describe("preview tools", () => {
  it("are the four documented names", () => {
    expect(tools.map((t) => t.name)).toEqual([
      "preview_start",
      "preview_list",
      "preview_logs",
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

  it("tells the model to prefer preview_start over shell background", () => {
    expect(tools[0]?.description.split("\n")[0]).toContain(
      "not shell background/nohup",
    );
  });
});
