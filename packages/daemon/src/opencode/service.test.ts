import { describe, expect, it } from "vitest";
import { opencodeOneVersion, startsTask } from "./service.ts";

describe("startsTask", () => {
  it("is true for creating a session and for work in one", () => {
    expect(startsTask("POST", "/api/session")).toBe(true);
    expect(startsTask("POST", "/api/session?location[directory]=/r")).toBe(
      true,
    );
    for (const action of ["prompt", "command", "shell", "fork"]) {
      expect(startsTask("POST", `/api/session/ses_1/${action}`)).toBe(true);
    }
  });

  it("is false for reads and other writes", () => {
    expect(startsTask("GET", "/api/session")).toBe(false);
    expect(startsTask("GET", "/api/event")).toBe(false);
    expect(startsTask("POST", "/api/session/ses_1/interrupt")).toBe(false);
    expect(startsTask("PATCH", "/api/session/ses_1")).toBe(false);
    expect(startsTask("POST", "/api/sessions")).toBe(false);
  });
});

describe("opencodeOneVersion", () => {
  it("spots an opencode 1 binary", () => {
    expect(opencodeOneVersion("1.18.30\n")).toBe("1.18.30");
    expect(opencodeOneVersion("opencode v1.18.30")).toBe("1.18.30");
  });

  it("passes opencode 2, betas and unreadable output", () => {
    expect(opencodeOneVersion("opencode v2.1.2\n")).toBeNull();
    expect(opencodeOneVersion("opencode2 v0.0.0-beta-19192\n")).toBeNull();
    expect(opencodeOneVersion("")).toBeNull();
  });
});
