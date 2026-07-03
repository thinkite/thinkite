import { describe, expect, it } from "vitest";
import {
  isIpv6CandidateAddress,
  isPrivateCandidateAddress,
  normalizeIceServersForWerift,
} from "./webrtc-peer.js";

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

// Cloudflare TURN denies CreatePermission/ChannelBind for private ranges;
// these tests pin which candidate addresses the relay-only path must drop
// before werift ever asks for a permission.
describe("isPrivateCandidateAddress", () => {
  const cand = (addr: string) =>
    `candidate:1 1 udp 2130706431 ${addr} 54706 typ host generation 0`;

  it.each([
    ["10.20.30.40", true],
    ["192.168.86.56", true],
    ["172.16.0.9", true],
    ["172.31.255.1", true],
    ["169.254.10.10", true],
    ["127.0.0.1", true],
    ["abcd1234.local", true], // mDNS-obfuscated (iOS libwebrtc)
    ["fe80::1805:c657:40f2:82f0", true],
    ["fda1:7e14:5a29:fbb::1", true],
    ["::1", true],
    // public — cellular CGNAT-adjacent publics and CF relay ranges stay
    ["172.58.167.5", false], // 172.32+ is public (T-Mobile)
    ["104.30.147.63", false],
    ["208.88.200.199", false],
    ["48.43.173.217", false],
    ["2607:fb90::1", false],
  ])("%s → %s", (addr, expected) => {
    expect(isPrivateCandidateAddress(cand(addr))).toBe(expected);
  });

  it("returns false for malformed candidate strings", () => {
    expect(isPrivateCandidateAddress("")).toBe(false);
    expect(isPrivateCandidateAddress("candidate:1 1 udp")).toBe(false);
  });
});

// Cloudflare TURN issues IPv4 relay addresses only — an IPv6 peer target in
// CreatePermission fails (443 family mismatch) and poisons werift's turn
// protocol, so relay-only mode must drop ALL v6 remotes, public included.
describe("isIpv6CandidateAddress", () => {
  const cand = (addr: string) =>
    `candidate:1 1 udp 2130706431 ${addr} 54706 typ host generation 0`;

  it.each([
    ["2607:fb90:1234::1", true], // public cellular v6 — the field-failure case
    ["fe80::1805:c657:40f2:82f0", true],
    ["::1", true],
    ["172.58.167.5", false],
    ["104.30.147.63", false],
    ["abcd1234.local", false], // not v6 (mDNS name; the private check owns it)
  ])("%s → %s", (addr, expected) => {
    expect(isIpv6CandidateAddress(cand(addr))).toBe(expected);
  });
});
