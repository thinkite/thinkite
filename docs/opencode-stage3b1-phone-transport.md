# opencode stage 3b-1: phone transport — `fetch` over the iroh HTTP tunnel + session list

You are working in the Thinkite monorepo (Apache-2.0, bun workspaces, TypeScript 6
defaults, ESM with NodeNext `.ts` import specifiers, vitest, biome). The iOS app
is `packages/app`: Expo 57, React Native 0.86, Hermes, expo-router, TanStack DB
(`@tanstack/react-db`), LegendList, `react-native-iroh-ffi` 0.1.0-alpha.4 (our
uniffi binding of iroh 1.1). Branch: `opencode`. Do NOT commit; leave changes
in the working tree.

## Context

Desktop already consumes opencode v2 through `@thinkite/oc-client`
(`packages/oc-client`: SDK wrapper, pure reducers, and the `./tanstack` entry
with `createSessionsCollection` / `createTranscriptCollections`) — see
`docs/opencode-stage2-report.md` and `docs/opencode-stage2b-report.md`.
The daemon now exposes opencode to paired phones over iroh: ALPN
`thinkite/http/1`, one HTTP/1.1 exchange per bi-stream, Basic auth injected
daemon-side — the wire contract is spelled out in
`docs/opencode-stage3a-report.md` ("The tunnel's wire contract"). Read that
section first; it is binding.

The phone today talks to the daemon only over Thinkite's RPC ALPN
(`packages/app/src/lib/iroh-wire.ts` → `connectIrohWire`, `wire-transport.ts`,
`daemon-client.ts`, `daemon-client-context.tsx`). That path stays for
pairing, git status, filesystem roots and the cwd picker. This stage adds the
second path and swaps ONE screen onto it: the session list. The transcript
swap is stage 3b-2.

A spike already implemented the phone-side HTTP client over a BiStream and
proved it against this daemon/opencode version — start from it:

```
git show spike/iroh-http-client:packages/app/src/lib/iroh-http.ts
git show spike/iroh-http-client:packages/app/src/app/\(main\)/dev/iroh.tsx
spikes/oc-proxy/README.md   # spike 1b section: half-close and lazy-SSE gotchas
```

(`git show` is read-only; do not check out that branch.) The spike's client
is request/response + a hand-rolled SSE parser. You will reshape it into a
`fetch` so the SDK's own SSE parser runs unchanged.

## Runtime facts (verified — do not add polyfills)

Expo 57's winter runtime installs `ReadableStream`/`TransformStream`
(`expo/virtual/streams.js` = web-streams-polyfill 4.1, injected by Metro),
`TextDecoder`, `TextDecoderStream`, `TextEncoderStream`, `URL`, and a
streaming `fetch` (`expo/fetch`); React Native supplies `Request`,
`Response`, `Headers`. `@opencode-ai/sdk`'s client builds `new Request(url,
init)` and its SSE parser needs only `response.ok`, `response.status`,
`response.body.pipeThrough(new TextDecoderStream())`. Metro resolves package
`exports` (`@opencode-ai/sdk/v2/client`, `@thinkite/oc-client/tanstack`) —
verify once with a typecheck + a Metro bundle (`bunx expo export
--platform ios` from `packages/app`, output to a temp dir) and report the
result.

## Deliverables

### A. `packages/app/src/lib/iroh-fetch.ts`
`createIrohFetch(opts): typeof fetch` where `opts` gives a way to open a
bi-stream to the daemon on ALPN `thinkite/http/1` (reuse the endpoint /
identity / daemon EndpointId plumbing in `iroh-wire.ts`; add a small
`openHttpStream()` there rather than duplicating dial code).
- Input: `Request | string | URL` + `RequestInit` (hey-api passes a
  `Request`). Serialize method, path+query (the `baseUrl` is a placeholder
  origin such as `http://daemon.iroh`; only the path is sent), headers, and
  the body (string / Uint8Array / ArrayBuffer; JSON in practice) as
  HTTP/1.1 with `content-length`.
- Output: an object satisfying what the SDK touches — `ok`, `status`,
  `statusText`, `headers` (a `Headers`), `url`, `body` (a `ReadableStream<
  Uint8Array>` fed by the bi-stream read loop, honoring content-length,
  chunked, and close-delimited bodies), `json()`, `text()`,
  `arrayBuffer()`. Constructing a real `Response` with a stream body is
  optional if RN's `Response` rejects stream bodies — say which you did.
- One bi-stream per request. Keep the send side open until the response has
  been fully consumed, then `finish()`; `AbortSignal` abort → `reset(0)` +
  `stop(0)` and the body stream errors with an `AbortError`. SSE responses
  stay open until aborted.
- Errors: connection failures reject like `fetch` does (`TypeError`), HTTP
  errors are returned as responses (the SDK throws on `!ok`).

### B. `packages/app/src/lib/oc.ts`
Renderer-wide singletons for the phone, mirroring
`packages/desktop/src/lib/oc.ts`: `getOcClient()` =
`createOcClient({ baseUrl: "http://daemon.iroh", fetch: irohFetch })`,
`sharedOcBus`, `sessionStateCollection`, `getTranscriptCollection` /
`evictTranscriptCollection` / `sendUserMessage`. Dev override:
`EXPO_PUBLIC_OC_BASE_URL` (when set, use the global `fetch` against that
URL — e.g. the desktop's `/oc` proxy on loopback — instead of the tunnel).
Bus and collections must not start before the phone is paired and the
daemon connection is online — gate on the existing connection status from
`daemon-client-context.tsx` (`ConnectionStatus`), and tear down / re-open on
offline→online.

### C. Session list on opencode
`packages/app/src/app/(main)/(drawer)/(stack)/index.tsx`,
`components/session-list-sidebar.tsx`, `components/session-row.tsx`, and
`lib/sessions-collection.ts`: rows come from `createSessionsCollection`
(`SessionRow`: `id`, `title`, `directory`, `model`, `updatedAt`,
`activity`), keyed by the opencode `ses_*` id. Keep the existing
day-sectioned layout, sorting by `updatedAt` desc, the running dot, and
the navigation to `session/[cliSessionId]` (rename the param to
`[sessionId]` only if it is a mechanical rename across the app; otherwise
keep the name and pass the `ses_*` id through it — the transcript screen
still runs on the old path until 3b-2 and will simply show the old
empty-state for these ids; that is expected and must not crash).
"New session" from the cwd picker creates via `getOcClient().createSession`
with `location.directory` and navigates. Delete (swipe/row action if one
exists today) → the documented v1 delete shim.

### D. Tests
- `iroh-fetch.test.ts` with an in-memory fake BiStream pair: request
  serialization (method/path/headers/content-length), content-length body,
  chunked body, close-delimited body, SSE body delivered incrementally
  through the `ReadableStream` (three `data:` events read before the stream
  closes), abort → reset/stop + `AbortError`, `finish()` only after the body
  is consumed.
- Session list: a test for whatever pure mapping you add (e.g. row → section
  grouping) if you extract one.
- `bun run typecheck`, `bun run test`, `biome check` on touched files green.

### E. Report → `docs/opencode-stage3b1-report.md`
File list, the fetch shim's contract and what `Response` shape you return,
the Metro bundle result for the two `exports` subpaths, what could not be
verified (a simulator run is done by the maintainer), open questions.
No local absolute paths.

## Rules
- Do not modify `packages/daemon`, `packages/desktop`, `packages/protocol`,
  `spikes/`. `packages/oc-client`: additive only, and say what you added.
- Do not touch the transcript screen, `chat-panel.tsx`, `input-bar.tsx`,
  `tool-*.tsx`, the markdown renderer, or `pierre-view.tsx` (3b-2).
- No new dependencies. No polyfills (see runtime facts).
- Do not run `git commit` / `git push` / `git checkout`. Do not read
  credential files. Do not print env vars.
- Comments in English, in the voice of the surrounding code; keep the spike's
  "why" comments when porting.
