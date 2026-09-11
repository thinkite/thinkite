# opencode stage-3a report: iroh HTTP tunnel in the daemon (`thinkite/http/1`)

Branch `opencode`. Nothing committed; all changes are in the working tree.
No new dependencies. `packages/app`, `packages/oc-client`, and `spikes/` are
untouched. `packages/protocol` changed only additively (the new ALPN
constant plus its barrel export). `packages/desktop` was touched in exactly
one place — the E2E cleanup delete that deliverable D explicitly requests.
The design is a direct port of `spikes/oc-proxy` (README, `iroh-duplex.ts`,
`proxy.ts`, `daemon-side.ts`, `client.ts`, `run.ts`); no redesign.

Tested against the repo's installed stack: `@number0/iroh` 1.1.0 (NAPI-RS),
opencode 1.18.30.

## File list

New — `packages/daemon/src`:

- `iroh-duplex.ts` — `irohDuplex(bi, log?)`: wraps a `BiStream` as a Node
  `Duplex` (read loop with backpressure, serialized writes via a promise
  chain, `final → send.finish()`, `destroy → send.reset(0) + recv.stop(0)`,
  no-op socket methods, `remoteAddress = "iroh"`). Comments are the spike's,
  including the "stream finished/reset by peer → EOF (not an error for
  HTTP)" rationale.
- `opencode-proxy.ts` — `createProxyServer({ getUpstream, log })`:
  non-listening `http.Server`, fed via `server.emit("connection", duplex)`.
  Per request it awaits `getUpstream()` (lazy opencode start), injects Basic
  auth, deletes the client `authorization`, strips `accept-encoding` "to keep
  SSE unbuffered", rewrites `host`, streams the request body up and the
  response down, `flushHeaders()` for `text/event-stream`, destroys the
  upstream request when the client response closes, `keepAliveTimeout = 0`,
  and sets `httpAllowHalfOpen = true` (the QUIC half-close gotcha).
  A failed `getUpstream()` (or a configured-but-missing host) answers
  `502` with `{"error":"opencode_unavailable","message":…}` and logs it.
- `iroh-http-tunnel.ts` — `IrohHttpTunnel`: owns the proxy + the set of
  active tunnel `Connection`s. `serveConnection(conn)` logs
  `iroh.http.accepted`, then accepts bi-streams in a loop, feeding each into
  the proxy as one HTTP/1.1 connection. `activeConnections()` backs the
  server counter; `stop()` closes every connection and the proxy
  (`closeAllConnections()` + `close()`).

New tests — `packages/daemon/src`:

- `iroh-duplex.test.ts` — 4 tests against an in-memory fake BiStream:
  serialized writes with `finish` last (a delayed first write cannot reorder
  later ones), peer bytes → `data` and half-close → `end` with the write
  side still open, peer reset treated as EOF, `destroy` → `reset(0)` +
  `stop(0)`.
- `opencode-proxy.test.ts` — 4 tests against a real local `http.createServer`
  upstream, driven through an in-memory duplex pair: Basic auth injected and
  `accept-encoding` stripped (client `authorization` discarded), SSE chunks
  pass through unbuffered (the upstream holds the response open until the
  client has seen chunk 1), upstream request destroyed when the client
  socket closes, 502 JSON when the upstream cannot start.
- `iroh-http-tunnel.test.ts` — 2 non-gated full-wire tests (real second iroh
  endpoint, `minimal` preset): a paired `thinkite/http/1` connection reaches
  the tunnel and gets the 502 JSON (no opencode configured), the counter
  reads 1 then 0, and `iroh.http.request` carries method/path/status; an
  unknown HTTP peer is closed by the shared gate with
  `iroh.http.rejected_unknown` and is not persisted.
- `iroh-http-tunnel.e2e.test.ts` — the gated (`THINKITE_E2E_IROH_HTTP=1`)
  live scenario, port of `spikes/oc-proxy/client.ts` + `run.ts`.

Modified:

- `packages/protocol/src/wire-frame.ts` — additive `IROH_HTTP_ALPN =
  "thinkite/http/1"` with the one-paragraph wire-contract doc comment.
- `packages/protocol/src/index.ts` — re-exports the new constant (it is an
  explicit named-export barrel; without this line daemon/iOS cannot import
  it).
- `packages/daemon/src/iroh-peer-server.ts` — advertises both ALPNs,
  dispatches on `conn.alpn()`, instantiates the tunnel (`opencode` option),
  stops it with the server, and adds `httpTunnelCount()` next to
  `authenticatedCount()`. The unknown-peer log is `iroh.http.rejected_unknown`
  for the HTTP ALPN and stays `iroh.peer.rejected_unknown` for RPC.
- `packages/daemon/src/index.ts` — passes
  `opencode: () => opencodeHost.ensureConnection()` into `IrohPeerServer`
  (3 lines).
- `packages/daemon/src/opencode/session-loop.e2e.test.ts` — best-effort
  v1-route delete in `finally`.
- `packages/desktop/server/oc-proxy.e2e.test.ts` — best-effort v1-route
  delete in `finally` before the proxy/host close (the existing mid-test
  delete stays).

## The tunnel's wire contract (as the phone side must implement it)

Transport:

- The daemon endpoint is identified by the pairing ed25519 pubkey (the
  EndpointId IS the pubkey bytes, base64url in the QR). Dial it with ALPN
  bytes `"thinkite/http/1"`; the same endpoint still advertises
  `"thinkite/rpc/1"` and dispatches on the negotiated ALPN.
- Admission is the same `known_clients` gate as RPC: the QUIC handshake
  proves possession of the key; unknown peers are refused (application close
  code 1, reason `"unknown"`) unless the pair window is open. Pairing over
  the HTTP ALPN persists the client into `known_clients.json` exactly like
  RPC.
- One bi-stream carries one HTTP/1.1 connection. Requests and responses are
  ordinary HTTP/1.1 bytes (request line, headers, body; response status,
  headers, body — content-length, chunked, or close-delimited). SSE uses
  `text/event-stream` with `\n\n`-separated blocks; the daemon flushes
  headers with the first chunk, so headers may not arrive until the first
  event (lazy SSE headers — never `await` the stream open before sending the
  prompt).
- Credentials never cross the tunnel. The daemon replaces any client
  `authorization` header with its own Basic credentials toward opencode.
  A client must not rely on — or need to know — the opencode password; a
  direct unauthenticated hit on the opencode port is 401.
- Half-close: the daemon's proxy sets `httpAllowHalfOpen`, and the client
  should keep its send side open until the response has been consumed
  before calling `send.finish()` (the spike's phone found early finish made
  Node's server treat the socket as gone). Aborting a request/SSE stream is
  a QUIC reset: `send.reset(0)` + `recv.stop(0)`.
- SSE resume: after a reset, open a fresh bi-stream and request
  `/api/session/<id>/event?after=<last durable seq>`; durable events resume
  at `last + 1` with no gaps or duplicates. `…/history?after=N&limit=…`
  returns the same page.
- Errors are HTTP-visible: opencode unavailable (or not yet started past
  its startup budget) → `502 {"error":"opencode_unavailable","message":…}`;
  opencode API errors keep their own status/body.

Daemon-side structured logs (via the existing `log(event, fields)` channel):
`iroh.http.accepted`, `iroh.http.request` (`method`, `path`, `status`, `ms`;
plus `error` on failures), `iroh.http.rejected_unknown`. The port also emits
`iroh.http.stream` (duplex EOF/reset) and `iroh.http.closed`.

## How ALPN dispatch was verified against the installed `@number0/iroh`

The binding exposes three relevant surfaces (`node_modules/@number0/iroh`,
1.1.0):

- `EndpointBuilder.alpns(alpns: Array<Array<number>>): void`
- `Accepting.alpn(): Promise<Array<number>>`
- `Connection.alpn(): Array<number>` — synchronous once connected.

A standalone Node probe (run under Node 24, `applyMinimal`, server bound to
loopback) bound one endpoint advertising `["thinkite/rpc/1",
"thinkite/http/1"]`, dialed it with `"thinkite/http/1"`, and printed:

- client `conn.alpn()` → `[116,104,105,110,107,105,116,101,47,104,116,116,112,47,49]`
  = `thinkite/http/1`;
- server `accepting.alpn()` → `"thinkite/http/1"`;
- server `conn.alpn()` → the same bytes.

`iroh-peer-server.ts` therefore uses the synchronous `conn.alpn()` right
after `accepting.connect()` and stringifies the bytes with
`Buffer.from(Uint8Array.from(...)).toString()`. The dispatch is also
regression-tested in-repo without a gate: `iroh-http-tunnel.test.ts` shows
an HTTP-ALPN connection reaching the tunnel (502 JSON, counter 1→0, request
log) while the pre-existing `iroh-peer-server.test.ts` suite (7 tests) shows
RPC hello/ping still working over the same endpoint.

## E2E event sequence observed

`THINKITE_E2E_IROH_HTTP=1 bunx vitest run
packages/daemon/src/iroh-http-tunnel.e2e.test.ts` passed twice (~11.3 s,
opencode 1.18.30, `opencode-go/deepseek-v4.1-flash`, `minimal` preset).
Observed sequence (client-side log, plus the server's structured log):

1. `GET /global/health` → 200 in ~0.9 s (the first tunneled request pays the
   lazy `opencode serve` spawn; `iroh.http.request … status:200, ms:902`).
2. `POST /api/session` (`location.directory` = scratch dir) → 200,
   `ses_f704ba59…`; `GET /api/session?directory=…` → 200.
3. SSE #1 `…/event?after=0` opened concurrently with
   `POST …/prompt {prompt:{text:"reply with exactly: pong"}}` → 200:
   - seq 1 `session.next.prompt.admitted`
   - seq 2 `session.next.prompted`
   - seq 3 `session.next.step.started` → client resets the stream
     (server log: `iroh.http.stream … recv end: Reset(0)`).
4. SSE #2 `…/event?after=3` resumed immediately:
   - seq 4 `session.next.reasoning.started`
   - seq 5 `session.next.reasoning.ended`
   - seq 6 `session.next.text.started`
   - seq 7 `session.next.text.ended` (`text: "pong"`)
   - seq 8 `session.next.step.ended`
   - 8 s idle → settle; contiguity asserted: starts at `abortAt + 1`, every
     step +1 across the reset (`4..8`), no gaps or duplicates.
5. `GET …/history?after=3&limit=100` returns the identical seq count, and
   the final durable text is exactly `pong`.
6. `DELETE /session/<ses_id>` (v1 route, no v2 equivalent) → 200
   (`iroh.http.request … DELETE … status:200`), so the scratch session is
   not left in the user's opencode database.

The same cleanup was added to and validated against the two existing gated
E2Es: `session-loop.e2e.test.ts` (`THINKITE_E2E_OPENCODE=1`, passed ~3.9 s)
and `oc-proxy.e2e.test.ts` (`THINKITE_E2E_OPENCODE=1`, passed ~11 s).

## Verification status

- `bun run typecheck` green (protocol, daemon, desktop incl. server tsconfig,
  app, oc-client).
- `bun run test` green: 663 passed, 3 skipped (the three gated live E2E
  files), 41 files — includes the 10 new non-gated tests.
- `bun run --cwd packages/daemon build` green; `dist/iroh-duplex.js`,
  `dist/opencode-proxy.js`, `dist/iroh-http-tunnel.js` emitted.
- All three gated E2Es pass when enabled (counts above).
- `biome check .` clean (239 files).

## What could not be verified

- The production `n0` preset (relays + pkarr discovery): every daemon test
  uses `minimal` and dials direct loopback addresses. Direct vs relayed QUIC
  behavior (path migration, relay latency, resets over a relay) is
  untested here.
- The phone side (stage 3b): no React Native/Hermes execution of the wire
  contract; only the Node client (the spike's, ported into the E2E).
- Concurrency and volume: multiple simultaneous tunnel connections/streams,
  HTTP keep-alive with several requests on one bi-stream, large upload
  bodies under backpressure, and multi-megabyte streams were not
  load-tested. The accept loop and proxy support them by construction.
- A real opencode process failing to start: the 502 path is unit-tested with
  a throwing resolver and full-wire-tested with the tunnel unconfigured, not
  against a genuinely failing `opencode serve`.
- The assembled `start()` daemon (`packages/daemon/src/index.ts`) was not
  booted end-to-end; its tunnel wiring is typechecked and the E2E builds the
  same `IrohPeerServer` + `OpencodeHost` pair directly.
- Package checks on the desktop renderer: the desktop E2E ran, but the
  Electron proxy path itself is stage-2 code and was not the subject here.

## Open questions

1. Should the tunnel's active-connection counter also be surfaced on the
   `Daemon` interface (next to `authenticatedPeerCount()`), or is the
   `IrohPeerServer.httpTunnelCount()` test hook enough for now?
2. One bi-stream per HTTP connection currently supports several requests
   (Node keep-alive); the phone may prefer one bi-stream per request. Which
   shape should the stage-3b `fetch` implement? The resume path only needs
   one request per stream.
3. The port emits two log events beyond the three the brief lists
   (`iroh.http.stream`, `iroh.http.closed`). Keep them for ops, or trim to
   the required set?
4. First-request latency: the lazy `opencode serve` start showed ~0.9 s here
   but can reach 30 s on a cold/broken server. Should the phone's `fetch`
   use a generous first-request timeout, or should the daemon pre-warm
   opencode when a paired HTTP peer connects?
5. Pairing over the HTTP ALPN: because the gate is shared, an unknown peer
   that dials `thinkite/http/1` while the pair window is open is admitted
   and persisted, same as RPC. Is that desired, or should pairing stay
   RPC-only?
6. `after=N` resume depends on the phone tracking the last `durable.seq`
   durably across app restarts; the daemon side imposes no other state.
