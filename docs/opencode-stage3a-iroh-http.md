# opencode stage 3a: iroh HTTP tunnel in the daemon (`thinkite/http/1`)

You are working in the Thinkite monorepo (Apache-2.0, bun workspaces, TypeScript 6
defaults, ESM with NodeNext `.ts` import specifiers, vitest, biome; the daemon
runs under Node ≥ 24 in production and `bun --watch` in dev — use only APIs
that work in both). Branch: `opencode`. Do NOT commit; leave changes in the
working tree.

## Context

Stages 1–2b (`docs/opencode-stage*.md` + reports) made the desktop app talk to
opencode v2 directly through a same-origin reverse proxy in Electron main
(`packages/desktop/server/oc-proxy.ts`), with the daemon owning the
`opencode serve` process (`Daemon.opencode()` → `{ baseUrl, username,
password }`, lazy start; `packages/daemon/src/opencode/host.ts`).

The iOS app reaches the daemon over iroh (QUIC, direct or relayed) — today
only for Thinkite's RPC protocol on ALPN `thinkite/rpc/1`
(`packages/daemon/src/iroh-peer-server.ts`, `packages/protocol/src/wire-frame.ts`).
Stage 3b will make the phone consume opencode v2 through `@thinkite/oc-client`
with a `fetch` implemented over an iroh bi-stream. This stage builds the daemon
half: a second ALPN that carries plain HTTP/1.1 (one request per bi-stream)
and reverse-proxies it to opencode.

A spike already proved every piece against this exact iroh/opencode version —
read it first and port it, do not redesign:

- `spikes/oc-proxy/README.md` — findings and gotchas (QUIC half-close after
  `send.finish()` needs `httpAllowHalfOpen`, lazy SSE headers, etc.).
- `spikes/oc-proxy/iroh-duplex.ts` — `@number0/iroh` BiStream → Node
  `Duplex` (read loop, serialized writes, `final → finish`, `destroy →
  reset/stop`, no-op socket methods).
- `spikes/oc-proxy/proxy.ts` — non-listening `http.createServer` fed via
  `server.emit("connection", duplex)`: Basic-auth injection, `accept-encoding`
  stripped, `flushHeaders` for SSE, upstream destroyed on client close,
  `keepAliveTimeout = 0`, `httpAllowHalfOpen = true`.
- `spikes/oc-proxy/daemon-side.ts` — endpoint bind with the extra ALPN and
  the accept loop that hands each bi-stream to the proxy server.
- `spikes/oc-proxy/client.ts` + `run.ts` — a Node iroh HTTP client and the
  end-to-end scenario (health, v2 create, prompt concurrent with SSE open,
  abort mid-stream, resume with `after=`, contiguity check). This is the
  spec for the gated E2E below.

## Deliverables

### A. Shared constant
`packages/protocol/src/wire-frame.ts`: `export const IROH_HTTP_ALPN =
"thinkite/http/1";` next to `IROH_RPC_ALPN`, with a one-paragraph doc comment
(one HTTP/1.1 exchange per bi-stream; client half-closes after the request
body; server half-closes after the response; SSE responses stay open until
the client resets).

### B. `packages/daemon/src/iroh-http-tunnel.ts`
- `IrohHttpTunnel` (or a function) that, given an accepted connection whose
  ALPN is `IROH_HTTP_ALPN`, accepts bi-streams in a loop and feeds each one
  to a proxy `http.Server` as a connection (port `iroh-duplex.ts` +
  `proxy.ts` into two daemon modules, `iroh-duplex.ts` and
  `opencode-proxy.ts`, keeping the spike's comments).
- The proxy targets `Daemon.opencode()` (start lazily on first tunnel
  request; if opencode cannot start, answer 502 with a JSON body).
- Auth gate: the SAME known-clients check the RPC ALPN performs
  (`iroh-peer-server.ts`, "known_clients gate") — unknown peers are closed
  with the same close code. Paired peers get every path proxied; the Basic
  auth password never leaves the daemon.
- Structured logs through the existing `log(event, fields)` channel
  (`iroh.http.accepted`, `iroh.http.request` with method/path/status/ms,
  `iroh.http.rejected_unknown`).

### C. Wire it into `IrohPeerServer`
`b.alpns([...])` advertises both ALPNs; the accept loop dispatches on
`conn.alpn()` (verify the exact `@number0/iroh` API for reading the
negotiated ALPN) — RPC connections keep their current handshake path
untouched; HTTP connections go to the tunnel. Expose a counter for active
tunnel connections next to `authenticatedCount()`. Nothing about the RPC
protocol, pairing, or the hello handshake changes.

### D. Tests
- Unit (vitest, colocated): `iroh-duplex.test.ts` with an in-memory fake
  BiStream pair (read/writeAll/finish/reset) proving half-close ordering
  and destroy semantics; `opencode-proxy.test.ts` against a local
  `http.createServer` upstream: Basic auth injected, `accept-encoding`
  stripped, SSE chunks pass through without buffering, upstream destroyed
  when the client socket closes.
- Gated E2E `THINKITE_E2E_IROH_HTTP=1` (`iroh-http-tunnel.e2e.test.ts`):
  start a real daemon `IrohPeerServer` with a known-clients store that
  contains the test client's key, dial it from a Node `@number0/iroh`
  client (port `spikes/oc-proxy/client.ts`), and run the `run.ts` scenario
  against the real opencode: health, create session in a scratch dir,
  prompt "reply with exactly: pong" concurrently with the SSE open, abort
  after 3 events, resume with `after=N`, assert contiguity and that the
  final text is "pong"; then DELETE the scratch session (v1 route) so the
  user's opencode database is not littered. Also add that same end-of-test
  delete to the two existing gated E2E files
  (`packages/daemon/src/opencode/session-loop.e2e.test.ts`,
  `packages/desktop/server/oc-proxy.e2e.test.ts`).
- `bun run typecheck`, `bun run test`, `bun run --cwd packages/daemon build`
  green; `biome check` clean on touched files.

### E. Report → `docs/opencode-stage3a-report.md`
File list, the tunnel's wire contract (as the phone side must implement
it), how ALPN dispatch was verified against the installed `@number0/iroh`,
the E2E event sequence observed, what could not be verified, open
questions. No local absolute paths.

## Rules
- Do not modify `packages/app`, `packages/desktop`, `packages/oc-client`,
  `spikes/`. `packages/protocol`: only the additive constant in A.
- Do not run `git commit` / `git push`. Do not read credential files
  (`auth.json`, `opencode.db`, `~/.config/opencode`, keychain). Do not print
  env vars.
- No new dependencies (`@number0/iroh` is already a daemon dependency).
- Comments in English, in the voice of the surrounding code; keep the
  spike's "why" comments when porting.
