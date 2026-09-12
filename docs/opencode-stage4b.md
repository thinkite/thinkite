# Stage 4b — move `@thinkite/oc-client` to `@opencode/client` 2.0.2

Read `docs/opencode-stage4a-report.md` first; it records what was verified and
why the design below differs from the 1.18.30 adapter.

## Goal

`packages/oc-client` speaks opencode 2 only. Rows are opencode's own
`SessionMessageInfo` projection; history comes from `message.list`; live
updates come from the shared `/api/event` bus; there is no durable-log replay
and no Thinkite message schema. Desktop and phone keep working through their
existing transports.

## Non-goals

- No daemon changes (4c does registry discovery). Keep `Daemon.opencode()`
  compiling by pointing it at the new client factory.
- No new UI. Desktop `TranscriptPanel`/`SessionSidebar` and the phone list
  screen must render the same information they render today, nothing more.
- No `./effect`, `./solid`, `./service` entries of `@opencode/client` outside
  the daemon.

## Dependencies

- `packages/oc-client/package.json`: replace `@opencode-ai/sdk` with
  `"@opencode/client": "2.0.2"` (exact pin). Do not run the install yourself;
  edit the manifest and stop so the owner runs `bun install`.

## Package layout (target)

```
packages/oc-client/src/
  client.ts            createOcClient({ baseUrl, fetch?, password?, pathPrefix? })
                       → OpenCode.make(...) with Basic auth header and the
                         prefix-rewriting fetch (see below)
  events.ts            OcEvent = EventSubscribeOutput; type guards for the
                       session.* subset; isDurable(e) → e.durable?.seq
  transcript-reducer.ts  applySessionEvent(rows: SessionMessageInfo[], e) →
                       SessionMessageInfo[] (pure; port of handleEvent's
                       message mutations from packages/client/src/solid/data.ts
                       on anomalyco/opencode `v2`, MIT — cite the file in a
                       header comment, do not vendor it)
  session-reducer.ts   applySessionListEvent(rows: SessionInfo[], e)
  status.ts            busy/idle from session.execution.* + session.active()
  tanstack/sessions.ts createSessionsCollection({ client, startSync? })
  tanstack/transcript.ts createTranscriptCollections({ client }) →
                       { get, evict, loadMore, sendUserMessage, disposeAll }
  model-ref.ts         keep (ModelRef is {providerID, id, variant?})
  identifier.ts        delete (server mints ids; prompt `id` is optional)
  bus.ts               delete (use client.event, it is already shared)
  index.ts
```

Delete `reducer.ts`, `session-list.ts`, `bus.ts`, `identifier.ts`, their tests
and the six `__fixtures__/*.json` (they are 1.18.30 `session.next.*` shapes).

## Behaviour

### Client
- `OpenCode.make({ baseUrl, headers: { authorization: "Basic " + base64("opencode:" + password) }, fetch })`.
- `pathPrefix` (desktop passes `/oc`): wrap `fetch` so a request URL whose path
  starts with `/api/` gets the prefix inserted. The generated client resolves
  `new URL("/api/...", baseUrl)` and drops any path on `baseUrl`.
- Phone passes its iroh `fetch` shim and no prefix (baseUrl stays the
  placeholder origin).

### Transcript collection (per session)
1. Hydrate: `message.list({ sessionID, limit: 100, order: "desc" })`, reverse,
   store `cursor.next` as the load-more cursor. Subsequent pages:
   `message.list({ sessionID, limit, cursor })` (no `order` with a cursor),
   prepend.
2. Live: subscribe to `client.event.subscribe()`; for events whose
   `data.sessionID` matches, run `applySessionEvent` and write the changed rows
   back (upsert by `id`; deltas append to the last open `text`/`reasoning`/
   `tool` content item of the addressed assistant message, keyed by
   `assistantMessageID` + `ordinal`/`callID` exactly as the upstream reducer
   does).
3. On `server.connected` (every reconnect): re-run step 1 and reconcile by
   message id; do not drop optimistic user rows that are not yet in the page.
4. `sendUserMessage(sessionID, text, model?)`: `session.prompt({ sessionID,
   text, model? })`; insert the returned inbox row as a pending `user` message
   until `session.inbox.delivered` / the projection confirms it.
5. `interrupt(sessionID)`: `session.interrupt({ sessionID })`.

### Sessions collection
- Hydrate: `session.list({ limit: 100 })` (+ pages by cursor); key by `id`.
- Live: `session.created` → `session.get`; `session.deleted` → remove;
  `session.renamed`/`moved`/`model.selected`/`agent.selected` → patch;
  `session.execution.started/succeeded/failed/interrupted` → status.
- Status snapshot: on `server.connected`, `session.active()`; ids present are
  `busy`, all others `idle`; later lifecycle events win.
- Status stays a separate row set (`session-status`) as today so the list
  screen can subscribe without the transcript.

### Create / delete
- `createSession({ directory, title?, model? })` → `session.create({ location:
  { directory }, title, model })`.
- `deleteSession(id)` → `session.remove({ sessionID })`.

## Consumers to update (minimal edits)

- `packages/desktop/src/lib/oc.ts`: `createOcClient({ baseUrl: window.origin, pathPrefix: "/oc" })`; remove `SharedBus`.
- `packages/desktop/server/oc-proxy.ts`: unchanged; it already forwards Basic auth and SSE.
- `packages/desktop/src/components/TranscriptPanel.tsx`, `routes/session/$sessionId.tsx`: render from `SessionMessageInfo` (`user.text`, `assistant.content[]` of `text` / `reasoning` / `tool`, `assistant.finish`, `assistant.error`). Replace `OcRow` switch with a `type`/`content.type` switch.
- `packages/desktop/src/components/SessionSidebar.tsx`, `routes/index.tsx`: `SessionInfo` fields (`title`, `time.updated`, `location.directory`).
- `packages/app/src/lib/oc.ts`, `sessions-collection.ts`, list screen: same swap; `OcRuntimeGate` semantics unchanged (start sync on online, only close the tunnel connection on offline).
- `packages/daemon/src/index.ts` `Daemon.opencode()`: construct through the new factory; nothing else.

## Tests

- Unit: `transcript-reducer.test.ts` driven by a recorded real bus stream.
  Record it with a script (`scripts/record-oc-events.ts`) that runs one
  `pong` turn and one tool turn against a running service and writes the raw
  `EventSubscribeOutput[]` plus the final `message.list` page as fixtures;
  the test asserts the reduced rows deep-equal the projection.
- Unit: sessions reducer + status transitions.
- E2E (gated `THINKITE_E2E_OPENCODE=1`): needs a running service; discover it
  from `~/.local/state/opencode/service.json`, create a session in a temp
  directory, prompt, wait for `session.execution.succeeded`, assert the
  transcript collection ends with an assistant `text` row equal to the
  projection, delete the session. If `health.get().version` is ≥ 2.0.0, set
  `permission.rules` to deny everything for that session first.
- `bun run typecheck` across all packages, `bun test` (vitest), `biome check`.

## Report

Write `docs/opencode-stage4b-report.md`: what changed, what the fixtures cover,
anything in the upstream reducer you deliberately did not port, and any shape
you observed that differs from the 4a report.
