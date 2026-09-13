# Stage 4b report — `@thinkite/oc-client` on `@opencode/client` 2.0.2

Done 2026-09-12 against the user's registered Beta desktop service
(`0.0.0-beta-19425`) with the stable client `@opencode/client@2.0.2`.

## What changed

- **oc-client rewritten on the promise entry of `@opencode/client`.**
  `client.ts` wraps `OpenCode.make` with a `pathPrefix` fetch (the generated
  client resolves `/api/…` against the origin and drops the Electron `/oc`
  mount) and Basic auth from a password. `events.ts` owns the bus loop the
  package does not: reconnect with 1–10 s backoff, 45 s idle timeout
  (three server keepalives), abort. Every (re)connection starts with the
  server's `server.connected` event, which is what the collections key
  their resync on.
- **Rows are opencode's projection.** `transcript-reducer.ts` folds the
  streaming subset (23 event types: inbox, synthetic, instructions, step,
  text, reasoning, tool, retry) into `SessionMessageInfo` rows with
  immutable updates; ported case by case from `handleEvent` in
  `packages/client/src/solid/data.ts` on anomalyco/opencode `v2` (MIT).
  `session-reducer.ts` flattens `SessionInfo` into `SessionRow` and patches
  it from `renamed/moved/model.selected/inbox.enqueued/execution.*`.
- **Collections.** `tanstack/transcript.ts` hydrates from
  `message.list` (20 newest, `order: desc`), keeps `cursor.next` for
  `loadOlder` (cursor only, no `order` — the server rejects the pair),
  folds live events, re-reads the tail on `execution.*` end and on
  reconnect, and coalesces a tail read 200 ms after any durable session
  event the reducer does not fold. `mergeProjection` replaces rows by id
  and keeps local-only rows (an input admitted after the read). A tiny
  `transcript-paging` collection carries `hasOlder / loading / hydrated`
  per session for screens. `tanstack/sessions.ts` reads up to 5 pages +
  `session.active()` on start and on every `server.connected`.
  `bus.ts`, `reducer.ts`, `session-list.ts`, `status.ts`, the six 1.18.30
  fixtures and the `@opencode-ai/sdk` dependency are gone.
- **Daemon finds the service instead of spawning one.**
  `opencode/registry.ts` reads `~/.local/state/opencode/service.json`,
  probes `/api/health` with the registered password, accepts only a
  healthy answer whose `pid` matches, caches 5 s. `Daemon.opencode()` (the
  `/oc` proxy and the phone's iroh tunnel) prefers it; the stage-1 spawn
  path remains only as a fallback and is dead on a machine with opencode 2
  installed (4c deletes it).
- **Desktop.** `lib/oc.ts` builds the client with `pathPrefix: "/oc"`;
  `TranscriptPanel` renders projection rows — a user row, an assistant's
  `content[]` as text / reasoning / tool rows (consecutive tools grouped
  into `ChatToolCalls`), system dividers for synthetic / system /
  compaction / switches — and pages with LegendList's `onStartReached`
  (threshold 0.5) plus a "Loading earlier messages…" header. The session
  route, sidebar and landing page compile unchanged.
- **Phone.** `lib/oc.ts` drops the shared bus; the connection gate and the
  iroh fetch shim are unchanged.
- **TanStack DB 0.6.14 → 0.9.0, react-db 0.1.92 → 0.3.8** (root catalog).
  Nothing we use changed; the live-query lifecycle fixes in 0.7–0.9 are
  the ones we wanted.

## What was verified

| Check | Result |
|---|---|
| `bun run typecheck` (5 packages) | clean |
| `bunx vitest run` | 670 passed, 4 skipped (gated) |
| `transcript-reducer.test.ts` | folding the recorded pong + read-tool turns (`scripts/record-oc-fixtures.ts`, 36 events) equals the server projection row for row |
| `tanstack/collections.test.ts` | hydrate, older page, live fold + settle, coalesced settle, reconnect resync, optimistic send |
| `opencode/registry.test.ts` | path, parse, pid gate, cache |
| `THINKITE_E2E_OPENCODE=1` oc-client E2E | create → prompt → settle → delete against the registered service |
| `THINKITE_E2E_OPENCODE=1` proxy E2E | same turn through `/oc` with credentials injected by the proxy |
| Desktop window | new session in a scratch directory, prompt with a `read` tool call: reasoning, text, tool rows and the "Instructions updated" divider stream in, composer returns to idle; opening the 271-message session and scrolling up loads one older page via `cursor=` |
| `biome check packages` | clean |

## Deviations from the brief

- **No `useLiveInfiniteQuery`.** Its window is anchored at offset 0 of the
  query order (the newest row) with a fixed limit, so every new message in
  a running turn pushes the oldest loaded row out of the window — the top
  of a chat would visibly lose rows while streaming. The transcript is a
  plain live query over the loaded window; paging is the collection's own
  cursor chain (`loadOlder`), which is also what opencode's GUI does.
- **No TanStack DB `on-demand` sync mode** for the same reason; the eager
  collection plus explicit `loadOlder` is simpler and testable.
- `SessionRow` stays a flat view of `SessionInfo` (title, directory, model
  string, updatedAt, activity) rather than the raw info: both list screens
  and the phone's day sections read those five fields.
- `session.instructions.updated` is folded (it materializes a `system`
  row with text), so the two recorded turns match the projection exactly
  without a settle read.

## Observed on the beta service

- Provider/model lists are fetched twice on session open (React strict
  mode double effect in dev) — harmless.
- After a turn the tail is read once for `execution.succeeded` and once
  more 200 ms later for the durable events that arrived after it
  (`instructions.updated`, `usage.recorded`); two small reads per turn.
- `onStartReached` fired once per scroll gesture; after a page lands the
  next gesture triggers the next page. The auto-continue opencode does
  (keep paging while still within 200 px of the top) is not implemented.
- Test sessions created during 4a/4b were deleted from the service
  afterwards.

## Leftovers for 4c

- Delete `packages/daemon/src/opencode/host.ts` spawn path, the stage-1
  session loop and normalizer, and `OPENCODE_PERMISSION` env handling.
- Version gate on `health.version` (`permission.rules` per session needs
  ≥ 2.0.0; the user's desktop is still beta 19425).
- Phone transcript screen (3b-2) on the new rows.
