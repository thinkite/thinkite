# opencode stage-2 report: desktop goes v2-native

Branch `opencode`. Nothing committed; all changes are in the working tree.
No changes to `packages/app`, `packages/protocol`, `packages/signaling`,
`packages/website`, or `spikes/`. One new workspace package, additive
daemon surface, desktop renderer + main rewired from the daemon `/rpc`
transcript path to opencode v2 through `@opencode-ai/sdk` 1.18.30.

## What was built (file list)

New — `packages/oc-client` (`@thinkite/oc-client`, framework-agnostic —
no React, no DOM, no Node-only APIs in the runtime entry; only
`@opencode-ai/sdk`, pinned exact `1.18.30` in lockstep with the opencode
binary the daemon spawns):

- `src/client.ts` — `createOcClient({ baseUrl, fetch?, headers? })` over
  the published SDK `v2/client` entry (`createOpencodeClient`, always
  `throwOnError: true`), plus UI helpers: session stream with `after=`
  (`openSessionStream`), shared global bus (`openEventBus`), both
  abortable async iterables; `history`, `prompt` (client-minted `id`),
  `interrupt`, `switchModel`, `listSessions`/`listProviders`/`listModels`/
  `listAgents`, permission/question replies, `activeSessionIDs`, and the
  documented v1-compat delete shim (`DELETE /session/:id`, 404 = gone).
- `src/reducer.ts` — pure transcript reducer: durable `session.next.*`
  (replay + follow) and live bus events folded into the row model below
  (`createInitialTranscriptState` / `applyOcEvent` / `foldOcEvents`,
  plus `ocStatusTransition`, `buildOcToolDetail`, `summaryForOcTool`,
  `ocToolOutputText`). Reduction logic ported from the official GUI's
  `server-session-v2-reducer.ts` + `global-sync/event-reducer.ts`
  (store mechanics dropped, merge semantics kept).
- `src/session-list.ts` — pure session-list reducer (`SessionV2Info`
  pages + `session.created/updated/deleted` bus events → items sorted by
  `time.updated` desc, archived hidden).
- `src/index.ts` — re-exports. `src/__fixtures__/` — the six stage-1
  fixtures, copied (daemon tests still use the originals).
- `src/reducer.test.ts` (14 tests), `src/session-list.test.ts` (4),
  `src/client.test.ts` (2, offline: `/oc` prefix + delete shim).

New — desktop main:

- `server/oc-proxy.ts` — `/oc/*` streaming reverse proxy (approach
  ported from `spikes/oc-proxy/proxy.ts`): strips `/oc`, injects Basic
  auth, drops `accept-encoding`, flushes SSE headers, destroys upstream
  when the client goes away. The spike's whole-server wrapper and QUIC
  half-open settings were deliberately not carried over (plain node http
  server defaults are fine here).
- `server/oc-proxy.test.ts` (offline: prefix strip, auth
  inject/override, SSE passthrough) and `server/oc-proxy.e2e.test.ts`
  (gated live E2E, below).

Modified:

- `packages/daemon/src/opencode/host.ts` — additive `OpencodeConnection`
  + `connection` getter + `ensureConnection()` (stored at spawn, cleared
  on exit/stop).
- `packages/daemon/src/index.ts` — additive `Daemon.opencode()`
  (lazy start, proxy use) + `OpencodeConnection` re-export. No behaviour
  change; iOS path untouched.
- `packages/desktop/server/index.ts` — `/oc/*` route (503 without
  daemon, 502 when opencode cannot start) + `/api/pick-directory`
  (native `dialog.showOpenDialog` for the landing page).
- `packages/desktop/vite.config.ts` — dev-server `/oc` proxy to the main
  port (renderer uses relative URLs in dev too).
- `packages/desktop/src/lib/oc.ts` (new) — renderer-wide singleton
  client (`${location.origin}/oc`), one shared bus fan-out with
  reconnect backoff, `parseModelRef`/`formatModelRef`.
- `packages/desktop/src/lib/sessions-collection.ts` — rows keyed by
  `ses_*` (`id/title/directory/model/updatedAt/activity`), fed by the
  session-list reducer (pages + bus) with `ocStatusTransition` busy/idle
  and one-shot `activeSessionIDs` seeding.
- `packages/desktop/src/lib/transcript-collections.ts` — rows are
  `OcRow & {_order}` (same kind-dispatch + `_order` style); history
  pages then one durable stream (`after=` resume, re-open loop) + shared
  bus routed by `sessionID`; optimistic send passes the client uuid as
  prompt `id` so `prompt.admitted` lands on the bubble by key.
- `packages/desktop/src/components/TranscriptPanel.tsx` — renders the
  new kinds (user/text/reasoning/tool groups/compaction/step-failed/
  revert); virtualization, scroll authority, Astryx rows unchanged.
- `packages/desktop/src/components/SessionSidebar.tsx` — title (or
  Untitled), directory basename, time/running dot, hover-reveal delete
  (v1 shim; bus removes the row; transcript cache evicted).
- `packages/desktop/src/routes/session/$sessionId.tsx` — composer →
  `session.prompt`, stop → `interrupt`, model picker from
  `/api/provider` + `/api/model` (switch at pick via the v2 model
  route), busy disables the composer and shows stop; loader waits
  through the create→navigate bus race; TerminalPane/DiffPanel keep
  `location.directory` as cwd (PTY keys are opaque strings — `ses_*`
  works unchanged).
- `packages/desktop/src/routes/index.tsx` — landing composer is real:
  directory field + Browse (native dialog, last pick in localStorage),
  create + first prompt + navigate to `/session/<ses_id>`.
- `packages/desktop/src/lib/daemon-rpc.ts` — shrunk to the connection
  lifecycle (hello/reconnect/dispose); the five session APIs are gone.
  Daemon-side `/rpc` handlers untouched (iOS still uses them).
- `packages/desktop/tsconfig.server.json` — `allowImportingTsExtensions`
  (the server E2E imports the daemon host by source).
- `vitest.config.ts` — additionally includes
  `packages/desktop/server/**/*.test.ts`.
- Root `package.json` — `packages/oc-client` workspace;
  `typecheck`/`build` cover it. `packages/desktop/package.json` —
  `@thinkite/oc-client` workspace dep. `bun.lock` — only
  `@opencode-ai/sdk@1.18.30` added (plus its own `cross-spawn`
  transitive dep); no other new dependency, so no further justification
  is owed.

## The reducer's row model

```ts
export type OcRow =
  | { kind: "user"; id: string; text: string };
  | { kind: "text"; id: string; text: string; streaming: boolean;
      assistantMessageID: string };
  | { kind: "reasoning"; id: string; text: string; streaming: boolean;
      assistantMessageID: string };
  | { kind: "tool"; id: string; name: string; status: "running" |
      "completed" | "error"; input: string; detail: OcToolDetail;
      summary: string; output: string; error: string | null };
  | { kind: "compaction"; id: string; reason: "auto" | "manual";
      summary: string; streaming: boolean };
  | { kind: "step-failed"; id: string; error: string };
  | { kind: "revert"; id: string; state: "staged" | "cleared" |
      "committed"; messageID?: string };

export interface OcTranscriptState {
  rows: OcRow[];
  status: "busy" | "idle";
  permissions: OcPermissionRequest[];
  questions: OcQuestionRequest[];
  usage?: OcUsage;
  lastSeq: number;      // `after=` resume cursor
  seenSeq: Set<number>; // durable dedupe
}
```

`OcToolDetail` is a per-tool union (bash/edit/read/write/glob/grep/
webfetch/websearch/task/question/unknown keeping name + raw input);
`summary` is the collapsed-row target. IDs: user = `messageID`, text =
`assistantMessageID:textID`, reasoning = `assistantMessageID:reasoningID`,
tool = `callID`, compaction = `messageID`, step-failed = event id,
revert = single `"revert"` slot.

## Merge rules implemented

- Durable events dedupe by `durable.seq` (`seenSeq`; out-of-order and
  duplicates converge); `lastSeq` feeds `after=` resume. Live deltas
  carry no seq and apply by key.
- Live deltas apply by `textID`/`reasoningID`/`callID` (`tool.input`
  accumulates raw JSON, replaced by the parsed object at `called`);
  the durable `*.ended` with full content overwrites (missed-delta
  reconcile). `tool.input.started` carries the tool `name`, so rows are
  named before `called` lands.
- Redelivered deltas are dropped once their row is finalized
  (`streaming === false`, non-`running` tool): the `/api/event` bus
  replays its bounded buffer to every new subscriber, so reconnects
  otherwise duplicate text (`"pongpong"`, observed live) and resurrect
  streaming rows.
- Turn state via `ocStatusTransition` (shared by the transcript reducer
  and the sidebar dots): busy on `prompt.admitted`/`prompted`/
  `step.started`; idle on `step.ended` unless `finish === "tool-calls"`
  (one prompt drives N steps — continuation is set only on tool-call)
  and on any `step.failed`; `session.status` overrides when present;
  deprecated `session.idle` still idles. No polling anywhere; the single
  `/api/session/active` read at startup seeds already-running turns
  (same as the official GUI's bootstrap).
- Usage = terminal `step.ended` tokens (last wins; token-less steps keep
  the previous reading). `prompt.admitted`/`prompted` share `messageID`
  (first wins); the prompt `id` param echoes as `messageID` (verified in
  server source and live), which is the optimistic-bubble reconcile.
- Unrelated bus events (`shell.*`, `synthetic`, `context.updated`,
  agent/model switched, `message.updated`, session list events, …)
  return the input state untouched.

## E2E sequences (observed, `THINKITE_E2E_OPENCODE=1`)

OpencodeHost + main-proxy code in-process, `@thinkite/oc-client`
through the proxy, scratch dir, model `opencode-go/deepseek-v4.1-flash`.
Turn 1 "reply with exactly: pong":

```text
stream: prompt.admitted → prompted → step.started → text.started →
  text.ended → step.ended
bus:    prompt.admitted → prompted → step.started → text.started →
  text.delta → text.delta → text.ended → step.ended
status: busy → idle
```

(user row with our id, one streaming text row converging to `"pong"`
`streaming: false`, usage `inputTokens > 0`, `activeSessionIDs`
contained the session while busy.) With reasoning turns the stream
additionally carries `reasoning.started → reasoning.ended` and the bus
the live `reasoning.delta` fragments. Interrupt run (long story prompt,
interrupted mid-reasoning):

```text
stream: prompt.admitted → prompted → context.updated → step.started →
  reasoning.started → reasoning.ended → step.failed
bus:    prompt.admitted → prompted → context.updated → step.started →
  reasoning.started → reasoning.delta ×N → reasoning.ended → step.failed
status: busy → idle
```

(step-failed row `"Provider turn interrupted"` asserted.) Then, without
spending further turns: provider+model lists loaded, model switched
(`opencode-go/omen-alpha`, confirmed via get), session deleted via the
v1 shim (get rejects, list excludes). hey-api URL joining is plain
string concat (`baseUrl + path`), so the `/oc` prefix holds for every
method including SSE (unit-asserted for unary, E2E-asserted for all).

Verification status: `bun run typecheck` (all 5 packages) green,
`bun run test` green (647 passed, 2 skipped — the two live gates),
`bun run --cwd packages/desktop build` green, `biome check` clean
repo-wide, `bun run --cwd packages/desktop dev` boots (Vite client +
main compile, in-process daemon up), E2E passed 3 consecutive runs
(~10s each). Two stalls were observed along the way (admitted prompts
never starting within 120s); reruns passed — backend flake, see below.

## What could not be verified

- A full Electron window run (maintainer does it): renderer behaviour
  past typecheck/build/dev-compile is covered at the client level by
  the E2E. Model picker UI, landing-page dialog flow, sidebar delete
  button, and PTY attach under `ses_*` keys were not clicked through.
- Real compaction (route is 503; synthetic fixture + reducer paths
  only), live permission/question asks (none fire with the deny env +
  auto-allow; synthetic unit tests only), revert (synthetic), image
  attachments (not sent), multi-page session lists, `history.hasMore`
  pagination beyond one page.
- `session.created/updated/deleted` driving the sidebar live (bus
  subscription is wired and unit-tested; the E2E session outlived its
  own created event, so no live observation).
- Second-turn start after an *early* interrupt: interrupting an
  admitted-but-not-started turn is a server no-op
  (`run-coordinator.ts`: no owner → return), and two such runs left
  the queued turn never starting within 120s. The E2E therefore waits
  for assistant rows before interrupting. Whether the wedge is
  interrupt-caused or backend flake is unconfirmed.
- Intermittent backend stalls (admitted prompts never starting; 2 in
  ~10 attempts) look like provider-side flake after many rapid turns,
  but were not root-caused server-side.
- The server ends idle session streams (and at least once the bus)
  shortly after turns settle; clients must re-open with `after=`
  resume (renderer and E2E both do). Durable replay converges, but a
  sub-second gap between end and re-open is inherent.

## Open questions for the maintainer

1. Turn-state currently trusts `finish !== "tool-calls"` as terminal.
   If a provider ever ends a mid-turn step with another finish value
   while continuing, busy flips early (next `step.started` heals it).
   Acceptable, or should `activeSessionIDs` backstop the open session?
2. Bus-buffer replay makes every reconnect re-deliver recent deltas;
   the finalized-row gates handle it. Should durable replay also carry
   event ids for exact dedupe, or are the gates sufficient?
3. `message.part.delta` is mapped best-effort onto text rows but was
   never observed on the bus (only `session.next.*.delta` was). Keep
   the mapping or drop it?
4. The vitest `node` condition resolves `@thinkite/oc-client` to
   `dist`, so node-side tests need a fresh `bun run build` after
   oc-client changes (a stale dist bit once, hard). Wire a pretest
   build or a vitest alias to source?
5. Delete is best-effort surfaced in the sidebar (error only logged).
   Should a failed delete toast, and should deleting the open session
   navigate home even if the bus event races?

## Discrepancies vs the brief (source/probe wins)

- **Turn state**: the brief's `session.status`-on-the-bus rule does not
  hold in 1.18.30 — the v2 engine (`core/src/session/*`) never
  publishes status for prompt turns (only legacy `opencode/src`
  paths do; zero `session.status` in any live capture). Busy/idle
  comes from `ocStatusTransition` instead; `session.status` stays as
  an override. The official app seeds from `session.active` (polled
  once) and the official CLI races events against an idle-poll of the
  v1 status route — both consistent with status events being absent.
- **`sdk.session.*` is the v1 group** (`/session/...`); everything v2
  lives under **`sdk.v2.*`** (`Session3` → `/api/session`, `Event2` →
  `/api/event`, `Provider2`/`Model`/`Agent`). First version of the
  client called v1 paths (caught by the `/oc`-prefix unit test).
- **`session.prompt` takes no model** (brief sketch had `model?`);
  model switches go through the v2 model route only (picker commits
  at pick time). `after` on `session.events` is string-typed in the
  SDK (history was patched to numbers upstream; events was not).
- **`session.idle` is schema-marked deprecated** (still mapped);
  `session.wait`/`compact` are 503 (untouched, as in stage 1).
- **No `session.next.*.delta` in the durable union** (confirms the
  stage-1 live-only finding): the session stream replays durables,
  the bus adds live deltas — plus, per the bounded buffer, redelivers
  recent ones on every (re)subscribe.
- The prompt `id` → `messageID` echo assumed for optimistic reconcile
  is real (`SessionInput.admit` publishes `messageID: input.id`;
  verified live).
