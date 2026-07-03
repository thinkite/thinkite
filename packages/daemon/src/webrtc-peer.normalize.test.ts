import { describe, expect, it } from "vitest";
import { normalizeIceServersForWerift } from "./webrtc-peer.js";

// werift's ICE config parser is much narrower than libwebrtc's: string-only
// `urls`, first turn: entry only, no turns:/tcp, naive host:port parsing.
// These tests pin the exact shape we feed it, with Cloudflare's
// /turn-credentials response shape (urls LISTS per entry) as the fixture.

describe("normalizeIceServersForWerift", () => {
  it("flattens Cloudflare's urls lists into string-urls entries", () => {
    const out = normalizeIceServersForWerift([
      { urls: ["stun:stun.cloudflare.com:3478"] },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:53?transport=udp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
        ],
        username: "u",
        credential: "c",
      },
    ]);
    expect(out).toEqual([
      { urls: "stun:stun.cloudflare.com:3478" },
      // first UDP turn: entry wins; query string stripped (werift would
      // otherwise parse the port as "3478?transport=udp")
      { urls: "turn:turn.cloudflare.com:3478", username: "u", credential: "c" },
    ]);
  });

  it("drops tcp/tls-only TURN variants rather than feeding werift a dead relay", () => {
    const out = normalizeIceServersForWerift([
      { urls: "stun:s.example:3478" },
      {
        urls: ["turns:t.example:5349?transport=tcp", "turn:t.example:3478?transport=tcp"],
        username: "u",
        credential: "c",
      },
    ]);
    expect(out).toEqual([{ urls: "stun:s.example:3478" }]);
  });

  it("passes plain string-urls STUN-only config through unchanged", () => {
    const out = normalizeIceServersForWerift([
      { urls: "stun:stun.cloudflare.com:3478" },
    ]);
    expect(out).toEqual([{ urls: "stun:stun.cloudflare.com:3478" }]);
  });

  it("keeps a bare turn: url with no transport query", () => {
    const out = normalizeIceServersForWerift([
      { urls: ["turn:t.example:3478"], username: "u", credential: "c" },
    ]);
    expect(out).toEqual([
      { urls: "turn:t.example:3478", username: "u", credential: "c" },
    ]);
  });
});
