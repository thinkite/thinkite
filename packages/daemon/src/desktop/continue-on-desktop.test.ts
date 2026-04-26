import { describe, expect, it, vi } from "vitest";
import {
  buildContinueDeepLink,
  continueOnDesktop,
  type OpenRunner,
} from "./continue-on-desktop.js";

describe("buildContinueDeepLink", () => {
  it("strips the local_ prefix when desktopLocalSessionId is provided", () => {
    const url = buildContinueDeepLink({
      cliSessionId: "03f3f808-9702-4dda-82da-34a8b3f76879",
      desktopLocalSessionId: "local_119c4694-f67a-4e16-b99c-140567c682fd",
    });
    expect(url).toBe(
      "claude://resume?session=119c4694-f67a-4e16-b99c-140567c682fd",
    );
  });

  it("falls back to cliSessionId when no desktopLocalSessionId", () => {
    const url = buildContinueDeepLink({
      cliSessionId: "0a264f0b-d5dc-41a0-b6a9-a2ccc978ab50",
    });
    expect(url).toBe(
      "claude://resume?session=0a264f0b-d5dc-41a0-b6a9-a2ccc978ab50",
    );
  });

  it("uses CLI-mirror dedup naturally when local_<cliSessionId> matches", () => {
    // CLI-origin session that Desktop has mirrored: localSessionId === "local_<cliSessionId>"
    // After stripping, the param equals cliSessionId — same as the no-mirror branch.
    const url = buildContinueDeepLink({
      cliSessionId: "600d5241-d883-4aa8-bfd1-c9e4c8a27660",
      desktopLocalSessionId: "local_600d5241-d883-4aa8-bfd1-c9e4c8a27660",
    });
    expect(url).toBe(
      "claude://resume?session=600d5241-d883-4aa8-bfd1-c9e4c8a27660",
    );
  });

  it("URL-encodes non-UUID parameter values defensively", () => {
    // Real session IDs are UUIDs but defense-in-depth: anything weird gets encoded.
    const url = buildContinueDeepLink({
      cliSessionId: "id with space&char",
    });
    expect(url).toBe("claude://resume?session=id%20with%20space%26char");
  });
});

describe("continueOnDesktop", () => {
  it("invokes the runner with the built deep link URL", async () => {
    const runner = vi.fn<OpenRunner>().mockResolvedValue(0);
    await continueOnDesktop(
      {
        cliSessionId: "abc",
        desktopLocalSessionId: "local_xyz",
      },
      runner,
    );
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith("claude://resume?session=xyz");
  });

  it("resolves when runner exits 0", async () => {
    const runner = vi.fn<OpenRunner>().mockResolvedValue(0);
    await expect(
      continueOnDesktop({ cliSessionId: "abc" }, runner),
    ).resolves.toBeUndefined();
  });

  it("rejects with the exit code when runner exits non-zero", async () => {
    const runner = vi.fn<OpenRunner>().mockResolvedValue(1);
    await expect(
      continueOnDesktop({ cliSessionId: "abc" }, runner),
    ).rejects.toThrow(/exited with code 1/);
  });

  it("rejects when runner exits with null (signal-killed)", async () => {
    const runner = vi.fn<OpenRunner>().mockResolvedValue(null);
    await expect(
      continueOnDesktop({ cliSessionId: "abc" }, runner),
    ).rejects.toThrow(/exited with code null/);
  });

  it("propagates runner rejection (e.g. spawn ENOENT)", async () => {
    const runner = vi
      .fn<OpenRunner>()
      .mockRejectedValue(new Error("spawn /usr/bin/open ENOENT"));
    await expect(
      continueOnDesktop({ cliSessionId: "abc" }, runner),
    ).rejects.toThrow(/ENOENT/);
  });
});
