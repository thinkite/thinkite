# opencode host — stage 2: desktop goes v2-native, no Thinkite session schema

You are working in the Thinkite monorepo (Apache-2.0, bun workspaces, TypeScript 6
defaults, ESM with NodeNext `.ts` import specifiers, zod v4, vitest, biome,
React 19, Electron 43, Vite 8, TanStack Router/DB, LegendList, Astryx 0.4.5,
Pierre). Branch: `opencode`. Do NOT commit; leave changes in the working tree.

Stage 1 (already on this branch, see `docs/opencode-stage1.md` and
`docs/opencode-stage1-report.md`) put `opencode serve` behind the daemon while
keeping Thinkite's own transcript schema. The maintainer has now decided:

1. **Sessions are opencode's.** The opencode `ses_*` id is THE session id
   everywhere in the desktop app (routes, collections, PTY keys). There is no
   Thinkite session metadata for opencode sessions — no JSON-per-session, no
   ownership tag, no title/cwd/model mirror. Everything comes from opencode's
   session Info and events.
2. **The desktop renderer consumes opencode v2 directly** through the published
   `@opencode-ai/sdk` (1.18.30, MIT) `v2/client` entry — not through the daemon's
   `/rpc` transcript path, and not through Thinkite's `TimelineItem` /
   `EventDelta` / `ToolCallDetail` / `SessionState` shapes. Those shapes stay in
   `packages/protocol` for now (the iOS app still uses them until stage 3); the
   desktop simply stops importing them for sessions and transcripts.
3. Turn state comes from events, never polling: `session.status` (busy/idle) on
   the `/api/event` bus. `session.idle` is deprecated; `session.wait` is 503 in
   this version.

Goal of stage 2: the desktop app lists opencode sessions, creates one from the
landing page, streams a turn (text, reasoning, tool calls, compaction) into the
existing virtualized transcript, switches model, interrupts, and deletes — all
via v2, with a framework-agnostic client+reducer package the iOS app can reuse
in stage 3.

## Read first

1. `docs/opencode-stage1-report.md` — every gotcha found live (multiple
   `step.ended` per prompt, `text.delta` live-only on the bus, `path` vs
   `filePath`, read output in `structured.content`, no v2 delete route,
   `OPENCODE_PERMISSION` recipe). `packages/daemon/src/opencode/*` is the
   working reference implementation of spawn + client + event mapping; reuse
   its knowledge, not its target shapes.
2. `../opencode/packages/sdk/js/src/v2/` — the SDK you will depend on:
   `client.ts` (`createOpencodeClient({ baseUrl, fetch?, headers? })`),
   `gen/sdk.gen.ts` (all `/api/*` methods incl. `session.event`/`events` SSE
   with `after=`, `history`, `prompt`, `interrupt`, `model`, `permission`,
   `question`, `/api/event` bus, `/api/provider`, `/api/model`, `/api/agent`),
   `gen/types.gen.ts` (the `session.next.*` durable event union and `Session`
   Info), `gen/core/serverSentEvents.gen.ts` (SSE parser: needs only
   `response.ok/status/body` + global `TextDecoderStream`).
3. `../opencode/packages/app/src/context/server-session-v2-reducer.ts` and
   `global-sync/event-reducer.ts` — the official GUI's v2 reducers (SolidJS
   store, but the reduction logic is what you are porting). Types there come
   from a private package; take yours from `@opencode-ai/sdk/v2/types`.
4. `packages/desktop/src/lib/transcript-collections.ts`,
   `components/TranscriptPanel.tsx`, `lib/sessions-collection.ts`,
   `routes/session/$sessionId.tsx`, `routes/index.tsx`,
   `components/SessionSidebar.tsx` — what changes. Keep the LegendList
   virtualization, the single-writer scroll authority, and the Astryx composer
   exactly as they are; only the data feeding them changes.
5. `packages/desktop/server/index.ts` — Electron main: one node http server
   (static, `/rpc` ws, diff, pty, pairing) and `startDaemon(...)`.
6. `spikes/oc-proxy/proxy.ts` — a working streaming reverse proxy in front of
   opencode (Basic auth injection, SSE flush, half-open handling).

## Deliverables

### A. `packages/oc-client` — new workspace package `@thinkite/oc-client`
Framework-agnostic (no React, no DOM, no Node-only APIs in the runtime
entry — the iOS app runs it on Hermes under Expo 57, which provides
`ReadableStream`, `TextDecoderStream`, streaming `fetch`, `URL`). Depends on
`@opencode-ai/sdk` (exact `1.18.30`, pinned in lockstep with the opencode
binary version the daemon spawns; add a comment saying so).
- `client.ts`: `createOcClient({ baseUrl, fetch?, headers? })` → the sdk v2
  client plus the few helpers the UI needs (open session stream with `after`,
  open global bus, both returning async iterables with an AbortSignal).
- `reducer.ts`: pure. Input: durable `session.next.*` events (replay + follow)
  and live bus events (`text.delta`, `reasoning.delta`, `tool.input.delta`,
  `session.status`, `session.updated/created/deleted`, `permission.v2.*`,
  `question.v2.*`). Output: an ordered row model for the transcript — user
  message, assistant text (streaming + final), reasoning, tool call
  (input, status, output, error, per-tool typed detail for bash/edit/read/
  write/glob/grep/webfetch/websearch/task/question), compaction marker, step
  failure, revert marker — plus per-session status (busy/idle), pending
  permission/question lists, usage from the terminal `step.ended`. Merge rule:
  live deltas are applied by `textID`/`reasoningID`/`callID`; the durable
  `*.ended` event with full content is authoritative and reconciles any missed
  delta; durable events are deduped by `seq`. No polling anywhere.
- `session-list.ts`: pure reducer for the session list from `/api/session`
  pages + `session.created/updated/deleted` bus events, sorted by
  `time.updated` desc, exposing `location.directory`, `title`, `model`,
  `time.archived`.
- Tests (vitest): move/copy the stage-1 fixtures from
  `packages/daemon/src/opencode/__fixtures__/` (they are real 1.18.30 logs) and
  record any new ones you need with the stage-1 script; cover text turn,
  tools turn (bash+edit+read), failed tool, interrupted turn, deltas-then-ended
  reconciliation, out-of-order/duplicate seq, compaction (synthetic is fine,
  mark it), status busy→idle, session list create/update/delete.

### B. Electron main: opencode endpoint + same-origin reverse proxy
- The daemon already owns the `opencode serve` process (`OpencodeHost` in
  `packages/daemon/src/opencode/host.ts`). Expose it on the `Daemon` handle
  returned by `start()` (e.g. `opencode(): Promise<{ baseUrl, username,
  password }>`, starting lazily) — additive change in `packages/daemon`.
- In `packages/desktop/server/index.ts`, add a streaming reverse proxy on the
  existing http server: `/oc/*` → opencode, injecting Basic auth, stripping
  `/oc`, passing SSE through unbuffered (flush headers, no
  `accept-encoding`, close upstream when the client closes). Port the
  approach from `spikes/oc-proxy/proxy.ts`. Credentials never reach the
  renderer. The renderer creates its client with
  `baseUrl: \`${location.origin}/oc\``. Verify hey-api's URL joining keeps
  the `/oc` prefix for every method including SSE.

### C. Renderer
- `sessions-collection.ts` → keyed by `ses_*` id, fed by `@thinkite/oc-client`
  `session-list` (initial page(s) + bus). `SessionSidebar` shows title,
  directory basename, relative updated time; archived sessions hidden.
- `transcript-collections.ts` → rows from the oc-client reducer into the
  TanStack DB collection `TranscriptPanel` already reads; keep the row `kind`
  dispatch style and `_order`. One session stream (`after=` resume on
  reconnect) + one shared global bus subscription for the app, routed to
  the open session by `sessionID`. Optimistic user bubble on send is fine;
  reconcile with the durable `prompt.admitted`/`prompted` event.
- `routes/session/$sessionId.tsx`: composer → `session.prompt`
  (`{ prompt: { text }, model? }`), interrupt → `session.interrupt`, model
  picker → `/api/provider` + `/api/model` (show the models the user's connected
  providers expose; current = `session.model`; switching calls the v2 model
  route), busy state → composer disabled/stop button. `TerminalPane` and
  `DiffPanel` keep working with `location.directory` as `cwd`.
- `routes/index.tsx`: make the landing composer real — pick a directory
  (Electron native `dialog.showOpenDialog` via a small main-process route,
  remembering the last one in `localStorage`), create the session
  (`location.directory`, model), send the first prompt, navigate to
  `/session/<ses_id>`.
- Delete session (sidebar action) → v1 compat `DELETE /session/:id`
  (no v2 delete exists) — expose it in oc-client as a documented shim.
- Remove desktop's use of `/rpc` for `subscribeSessions` / `subscribe` /
  `sendPrompt` / `interrupt` / `setSessionSelection`. Keep `/rpc` for what
  is not opencode's (pairing, git status/diff, pty). `daemon-rpc.ts` shrinks
  accordingly; do not delete the daemon-side handlers (iOS still uses them).

### D. Verification
- `bun run typecheck`, `bun run test`, `bun run --cwd packages/desktop build`
  all green; `biome check` clean on touched files.
- Node-level E2E gated by `THINKITE_E2E_OPENCODE=1`: start the daemon's
  OpencodeHost + the Electron-main proxy code in-process (no Electron window),
  drive `@thinkite/oc-client` through the proxy: create session in a scratch
  dir, prompt "reply with exactly: pong", assert the reducer yields the user
  row, a streaming assistant row that ends with "pong", and status busy→idle
  from events; then interrupt a second long prompt and assert the failed-step
  row. Paste the observed event sequence into the report.
- Run `bun run --cwd packages/desktop dev` briefly to confirm Vite compiles;
  a full Electron window run is done by the maintainer.

### E. Report → `docs/opencode-stage2-report.md`
File list, the reducer's row model (as a TypeScript type excerpt), the merge
rules you implemented, the E2E sequences, what you could not verify, open
questions. No local absolute paths.

## Rules
- Do not modify `packages/app` (iOS) in this stage; `packages/oc-client` must
  nevertheless stay Hermes-compatible (no `node:*`, no DOM globals, no
  `Buffer`).
- Do not delete or change zod schemas in `packages/protocol` (stage 3).
- Do not touch `spikes/`. Do not upgrade Astryx or Pierre.
- Do not run `git commit` / `git push`. Do not read or copy credential files
  (`auth.json`, `opencode.db`, `~/.config/opencode`, keychain). Do not print
  environment variables.
- New dependencies: only `@opencode-ai/sdk`; anything else needs a one-line
  justification in the report. Edit `package.json` files and run `bun install`
  yourself.
- Comments in English, in the voice of the surrounding code (short "why"
  comments, relative file references).
- When the opencode source contradicts the stage-1 report, the source wins —
  note it in the report.
