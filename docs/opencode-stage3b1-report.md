# opencode stage-3b-1 report: phone `fetch` over the iroh tunnel + session list

Branch `opencode`. Nothing committed; all changes are in the working tree.
`packages/daemon`, `packages/desktop`, `packages/protocol`, and `spikes/`
are untouched. `packages/oc-client` changed additively only (two optional
API additions, listed below). The transcript screen, `chat-panel.tsx`,
`input-bar.tsx`, `tool-*.tsx`, the markdown renderer, and `pierre-view.tsx`
are untouched. No new external dependencies; `packages/app` gained the
existing workspace package `@thinkite/oc-client` (`bun.lock` +1 line).

## File list

New — `packages/app/src/lib`:

- `iroh-fetch.ts` — `createIrohFetch({ openStream }): typeof fetch`. Ports
  the spike's reader into a streaming `fetch` (method/path/headers/body
  serialization; content-length, chunked, and close-delimited bodies;
  abort; finish-after-consume).
- `iroh-fetch.test.ts` — 12 tests against an in-memory fake BiStream pair.
- `oc.ts` — phone twin of `packages/desktop/src/lib/oc.ts`:
  `getOcClient()`, `sharedOcBus`, `sessionStateCollection`,
  `getTranscriptCollection` / `evictTranscriptCollection` /
  `sendUserMessage`, plus `attachOcRuntime` / `detachOcRuntime` and the
  headless `OcRuntimeGate`.
- `session-sections.ts` + `session-sections.test.ts` — the pure
  day-bucketing helper extracted from the sidebar (3 tests).

Modified — `packages/app/src`:

- `lib/iroh-wire.ts` — added `openHttpStream(identity, daemonPubkey)` and
  `closeHttpConnection()`: one cached `thinkite/http/1` QUIC connection
  per process, `openBi()` per request, drop-and-retry-once when the cached
  connection died, endpoint/identity plumbing reused from `getEndpoint` /
  `EndpointId.fromBytes`.
- `lib/sessions-collection.ts` — the pre-existing daemon-RPC collection
  and its actions are unchanged (the transcript screen still imports
  them); appended the stage-3b-1 re-exports
  (`ocSessionStateCollection`, `getOcClient`, `sendUserMessage`,
  `evictTranscriptCollection`, `OcSessionRow`) from `./oc`.
- `hooks/use-sessions.ts` — reads `ocSessionStateCollection`, sorts by
  `updatedAt` desc, and returns a `null` query while `connectionStatus !==
  "online"` (so the hook can't start sync from under the gate).
- `components/session-list-sidebar.tsx` — row fields renamed to the
  opencode shape (`id` / `directory` / `updatedAt`); day-sectioned layout,
  `router.replace("/session/[cliSessionId]")` (param name kept), and the
  floating chrome unchanged.
- `components/session-row.tsx` — new `SessionRow` shape; the running dot
  and RNGH press/lift behavior kept. The long-press menu's bridge toggle
  (a CCR concept opencode has no equivalent for) became "Delete session",
  wired to the documented v1 `deleteSession` shim + transcript eviction.
- `app/(main)/(drawer)/(stack)/index.tsx` — new-session send now
  `getOcClient().createSession({ directory: cwd, model })`, fires the
  first prompt via `sendUserMessage` under a client-minted `msg_*` id,
  and replaces to `/session/[cliSessionId]` with the `ses_*` id.
- `app/_layout.tsx` — mounts `<OcRuntimeGate />` inside
  `DaemonClientProvider`.
- `package.json` — `@thinkite/oc-client: workspace:*`.

Additive — `packages/oc-client/src` (rebuilt `dist`, which is gitignored):

- `tanstack/sessions.ts` — `SessionsCollectionOptions.startSync?: boolean`
  (default `true`; desktop behavior unchanged). The phone passes `false`
  and starts sync from its connection gate.
- `tanstack/transcript.ts` — `TranscriptCollections.disposeAll(): void`:
  cleanup every cached transcript collection (abort stream + bus
  subscription) and clear the cache; used by the phone gate on offline.

## The fetch shim's contract

Request side:

- Input is normalized through `Request` (`input instanceof Request &&
  init === undefined` uses it as-is, avoiding a stream-body clone; other
  inputs go through `new Request(input, init)`).
- The placeholder origin is dropped: only `pathname + search` is written.
- `method … HTTP/1.1`, `host: daemon.iroh`, `connection: close`, then the
  request headers (lowercased, minus `host` / `connection` /
  `content-length`, which the shim owns). The body is always read via
  `request.arrayBuffer()` (RN's whatwg-fetch `Request` has no `.body`
  getter), and `content-length` is emitted whenever there is a body or
  the method is not GET/HEAD.
- One bi-stream per request; the send half is **not** finished after the
  bytes are written — the daemon's proxy reads an early half-close as a
  dead socket (stage 3a's half-close gotcha). `send.finish()` +
  `recv.stop(0)` run only once the response body is fully consumed.
- `AbortSignal` (the Request's own signal): `send.reset(0)` +
  `recv.stop(0)`, `body` errors with an `Error` named `AbortError`; the
  same happens for an abort that lands while `openStream()` is still in
  flight. SSE responses stay open until then.
- `openStream()` failures (and a stream dying before response headers)
  reject with a `TypeError`, like `fetch` does. HTTP status errors are
  returned as normal responses; the SDK throws on `!ok`.

Response side — a plain object cast to `Response`, **not** a real
`Response`: React Native's whatwg-fetch `Response` only accepts
string/Blob/ArrayBuffer-view bodies, so a `ReadableStream` body cannot be
constructed there. Fields provided: `ok`, `status`, `statusText`,
`headers` (a real `Headers` built from the parsed pairs), `url`,
`redirected`, `type`, `body` (a pull-based `ReadableStream<Uint8Array>`
fed by the bi-stream read loop), `bodyUsed`, `arrayBuffer()`, `text()`,
`json()`. `clone()` is not implemented (nothing in the SDK path calls
it). The SDK's SSE parser (`body.pipeThrough(new TextDecoderStream())`)
runs unchanged; chunks are `enqueue`d as they arrive, so three `data:`
events are readable before the server closes. Empty-by-definition
responses (HEAD, 204/304, `content-length: 0`) finish the request side at
header time — the SDK short-circuits those and would otherwise never
consume `body`.

## Connection gate

`packages/app/src/lib/oc.ts` creates the client/bus/collections at module
scope but with the sessions collection on `startSync: false` (transcript
collections are inert until first `get`). `OcRuntimeGate` — a headless
component under `DaemonClientProvider` (root layout) — watches the
existing `ConnectionStatus` from `daemon-client-context.tsx`:

- `online` → `sessionStateCollection.startSyncImmediate()` (idle or
  cleaned-up restarts; already-syncing is a no-op).
- anything else → `cleanup()` the sessions collection (stops sync, drops
  its bus subscription, clears rows), `disposeAll()` transcripts, close
  the cached HTTP connection.

`useSessions` independently returns a `null` live query while offline, so
a mounted list can't start sync under the gate. The transcript factory's
`get`/`sendUserMessage` still work on demand once online.

`EXPO_PUBLIC_OC_BASE_URL` is honored: when set (non-empty), the client is
created with that `baseUrl` and no custom `fetch`, i.e. the global fetch
against e.g. the desktop `/oc` loopback proxy; the gate still applies.

## Tests / verification

- `bun run typecheck` green (protocol, daemon, desktop incl. server,
  app, oc-client).
- `bun run test` green: 43 files, 681 tests — 678 passed, 3 skipped (the
  gated live E2Es). New: 12 `iroh-fetch` tests (serialization incl. no
  content-length on bodyless GET, content-length body, chunked,
  close-delimited, incremental SSE, abort mid-body, abort during open,
  finish-only-after-consume, open failure → TypeError, HTTP error
  responses) + 3 `session-sections` tests.
- `biome check .` clean (244 files).

## Metro bundle result

`bunx expo export --platform ios --output-dir <tmp>` from
`packages/app`:

- `iOS Bundled 8.2s node_modules/expo-router/entry.js (2608 modules)` —
  both subpaths resolve: the Hermes bundle contains the strings
  `createSessionsCollection` (the `@thinkite/oc-client/tanstack` entry)
  and `createOpencodeClient` / `x-opencode-directory` (the
  `@opencode-ai/sdk/v2/client` entry), plus `openHttpStream` and
  `thinkite/http/1`.
- The command still exits 1 in Expo's **DOM-component** step (`DOM
  Bundled … pierre-view.tsx`, then `Asset not found:
  _expo/static/js/web/__common-….js`). This is the web/dom export
  interacting with Metro bundle splitting and is unrelated to this
  change (nothing in the DOM component graph changed); the repo's own OTA
  scripts already set `EXPO_NO_BUNDLE_SPLITTING=1`.
- With `EXPO_NO_BUNDLE_SPLITTING=1` the same export exits 0 and emits the
  iOS Hermes bundle (6.9 MB) + the DOM `www.bundle`.

## What could not be verified

- No simulator/Hermes run: the real iroh dial, `sendUserMessage` prompt,
  v1 delete, list rendering, and gate transitions in a live app were not
  executed here (the maintainer's simulator run does that).
- No live daemon on this machine, so the wire contract is exercised only
  through the fake BiStream pair, not against `thinkite/http/1` from the
  phone runtime. The daemon-side E2E still covers the tunnel itself.
- The `EXPO_PUBLIC_OC_BASE_URL` dev override path was built/typechecked
  but not run.
- Keep-alive on one bi-stream is not exercised: this shim always sends
  `connection: close` (one bi-stream per HTTP exchange, per the brief).
- The first-request lazy `opencode serve` spawn (~0.9 s in stage 3a, up
  to ~30 s cold) has no phone-side timeout; the SDK's request just stays
  pending.

## Open questions

1. The gate keys off the RPC connection, but the HTTP tunnel is a
   separate QUIC connection. A daemon that accepts RPC while HTTP dials
   fail shows an empty list until the next RPC reconnect; should the
   fetch shim surface hard failures to the gate (or should the daemon
   pre-warm/accept-probe the HTTP path on RPC connect)?
2. Offline clears the list (the gate's cleanup drops rows). Is showing
   last-known rows while offline worth keeping a stale snapshot?
3. The new-session screen fires the first prompt immediately
   (`sendUserMessage` + durable stream) even though the transcript screen
   can't render it until 3b-2. Desktop parity says yes; a defer-until-3b-2
   alternative would leave typed first messages unsent for now.
4. Delete has no confirmation/undo (deliberate two-step long-press →
   menu, matching desktop). If the bus is offline at tap time the DELETE
   fails and the row stays; a retry/optimistic-remove treatment is
   deferred.
5. Images are dropped on the new-session first prompt (`_images` unused)
   until 3b-2; if that gap is too long, a small "attachments arrive in
   3b-2" affordance would be clearer than silently sending text only.
6. `dist/` of `@thinkite/oc-client` is gitignored, so the additive types
   are only visible after `bun run --cwd packages/oc-client build` (run
   here). A fresh clone already had this bootstrap requirement; worth a
   note in the root README at some point.
