# Stage 4a report — `@opencode/client` 2.0.2 against a running opencode 2 service

Spike, read-mostly, run on 2026-09-12 against the user's Beta desktop background
service (`opencode-cli serve --service`, version `0.0.0-beta-19425`, registry
`~/.local/state/opencode/service.json`) with the stable client
`@opencode/client@2.0.2`. One scratch session was created, prompted ("Reply with
exactly: pong"), inspected and deleted. Nothing else was written.

## Verdict

Go. The stable client talks to the beta service without a single shape error,
the promise entry is a 32 KB browser bundle with zero `effect` code, and the
official pattern for reading history is one we can copy verbatim. Two of our
current assumptions are wrong and change the 4b design:

1. **There is no durable event log to replay on a local service.**
   `GET /api/experimental/session/:id/log` returns only the `log.synced`
   watermark (`{aggregateID, seq}`) for every `after`, and even `follow=true`
   delivers nothing while a turn is running. Cause: `Bus.configured({ persist })`
   defaults `persist` to `false`; only the workerd (cloud) server sets
   `events.persist = true`. The local `opencode.db` confirms it: `event` table
   0 rows, `event_sequence` 106 rows, `session_message` 2016 rows. The v1 flow
   (`session.next.*` history + `after=`) has no v2 equivalent locally.
2. **History is the `session_message` projection**, read with
   `client.message.list({ sessionID, limit, order: "desc" })` and paged with
   `cursor` (a cursor cannot be combined with `order`; pass `order` on the first
   page only). This is exactly what the official Solid data layer does
   (`packages/client/src/solid/data.ts` on `v2`, MIT).

## What was verified

| Call | Result |
|---|---|
| `health.get()` | `{healthy, version, pid}` |
| `session.list({limit})` | `{data: SessionInfo[], cursor: {previous, next}}`; `SessionInfo` has `location.directory`, `model {providerID, id, variant}`, `outcome`, `time {created, updated, idle}`, `cost`, `tokens` |
| `message.list` | 271 messages in 4 pages / 178 ms; kinds `user`, `assistant`; assistant `content[]` kinds `text`, `reasoning`, `tool` |
| `session.get`, `session.active()` | status snapshot; `active` maps running session ids to `{type: "running"}` |
| `model.default({location})`, `session.create({location, title})`, `session.prompt({sessionID, text})` | prompt returns the inbox row (`delivery: "steer"`) |
| `event.subscribe()` | ordered stream for the turn: `session.created#0 inbox.enqueued#1 execution.started#2 instructions.updated#3 inbox.delivered#4 step.started#5 reasoning.started#6 text.started#7 reasoning.delta reasoning.ended#8 text.delta text.ended#9 step.streamed#10 step.ended#11 usage.updated execution.succeeded#12` (`#n` = `durable.seq`; deltas and `usage.updated` are volatile, no seq) |
| `session.remove` | deletes |
| `bun build --target browser` of `OpenCode.make` | 32.5 KB, 6 modules, no `effect`, no `node:` imports |

Durable event names are the 1.18.30 `session.next.*` names without the `next.`
prefix, plus new ones: `session.execution.{started,succeeded,failed,interrupted}`
(replaces `prompt.admitted`/`prompted` and is the right busy/idle source),
`session.inbox.*` (queue / steer), `session.usage.{recorded,updated}`,
`session.step.streamed`, `session.tool.progress`,
`session.message.content.updated`, `session.{renamed,moved,forked,viewed}`.

## Client mechanics that matter for us

- `OpenCode.make({ baseUrl, fetch?, headers? })`. Auth is a plain
  `authorization: Basic base64("opencode:" + password)` header. The phone's
  iroh fetch shim plugs into `fetch` unchanged.
- URLs are built with `new URL(path, baseUrl)` and every path is absolute
  (`/api/...`), so a `baseUrl` with a path prefix (our Electron `/oc` proxy)
  loses the prefix. Fix on our side: inject a `fetch` that rewrites
  `/api/...` → `/oc/api/...`. Upstream tracks this as anomalyco/opencode#46498.
- `client.event` is a `SharedEvents` fan-out: one `/api/event` SSE per client,
  N subscribers, `onActivity` heartbeat, `server.connected` is the first event
  of every (re)connection. That is our `SharedBus`; drop ours.
- Reconnect strategy in the official data layer: on `server.connected` refetch
  `session.active()` and invalidate cached reads (message list, session info).
  With no durable log, this refetch is the only gap recovery. Keep our
  `after=` logic out of 4b entirely.
- `session.log` with `follow: true` keeps the connection open but delivered no
  events on the local service. Do not depend on it.
- Permissions: `permission.rules({ sessionID, permissions: [{action, resource,
  effect}] })` exists in 2.0.2 (per-session rules, anomalyco/opencode#48351)
  but not in beta 19425; `permission.asked` / `permission.reply` events and
  routes exist in both. E2E on a 2.0.2 service can set deny rules per session
  instead of the `OPENCODE_PERMISSION` env we used on our own spawned serve.
- Dependencies: `@opencode/schema` and `@opencode/protocol` (runtime deps of
  the client) pull `effect@4.0.0-rc.112` (51 MB) into `node_modules`. The
  promise entry never imports it; `./effect`, `./solid` and `./service` do
  (`./service` needs Node `child_process`/`fs`, daemon only).

## Design consequences for 4b

- **Row type = `SessionMessageInfo`**, the projection shape opencode itself
  renders. Our `OcRow` union goes away; live events mutate projection rows the
  way `handleEvent` in `packages/client/src/solid/data.ts` does (68 cases, of
  which the `session.*` subset is ~40). That file is the spec; port the
  mutations, not the Solid store.
- Transcript collection: hydrate with `message.list` (desc, page), reverse,
  keep `cursor.next` for load-more, subscribe to the shared bus, refetch on
  `server.connected`.
- Sessions collection: `session.list` pages + `session.created/deleted/
  renamed/moved/execution.*` events + `session.active()` snapshot for status.
- Endpoint: read `~/.local/state/opencode/service.json` (daemon side), Basic
  auth from it, never pass a version (ignore policy). `health.get().version`
  gates features (`permission.rules` needs ≥ 2.0.0).

## Leftovers

- The daemon still has the 1.18.30 spawn path (`packages/daemon/src/opencode/host.ts`);
  the 1.18.30 binary no longer exists on the dev machine. 4c replaces it with
  registry discovery.
- Event-table growth (anomalyco/opencode#33356) does not apply to local
  services (`persist=false`); it is a cloud/desktop-1.x concern.
