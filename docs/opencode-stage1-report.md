# opencode stage-1 report: opencode as the agent host

Branch `opencode`. Nothing committed; all changes are in the working tree,
limited to `packages/daemon` (4 modified files, 1 new directory, 1 new
script). No changes to `packages/app`, `packages/desktop`,
`packages/signaling`, `packages/website`, or any `packages/protocol` schema.

## What was built (file list)

New — `packages/daemon/src/opencode/`:

- `host.ts` (A) — process supervisor. Spawns `opencode serve` lazily on the
  first opencode-hosted prompt with an explicitly allocated free port
  (bind-then-use; see discrepancy 1), random
  `OPENCODE_SERVER_USERNAME`/`PASSWORD`, `OPENCODE_CLIENT=thinkite`, and
  the permission env below. Parses the "listening on" line, polls
  `/global/health` with Basic auth until ready. Stops on `daemon.stop()`;
  unexpected exits are logged and the next prompt respawns lazily (no
  auto-restart backoff beyond that). Passes `THINKITE_OPENCODE_API_KEY`
  through to `OPENCODE_API_KEY` when set, otherwise relies on the user's
  opencode integration state; never reads `auth.json`/`opencode.db`/
  `~/.config/opencode`. Owns the single server-wide live bus
  (`/api/event`) feeding live-only `*.delta` fragments to session loops
  plus the permission/question auto-reply backstop. `agentHost()`
  (`THINKITE_AGENT_HOST=claude|opencode`, default `opencode`),
  `resolveOpencodeModel()` (`sendPrompt.model` / `setSessionSelection`
  `providerID/modelID` split on first `/`, else `THINKITE_OPENCODE_MODEL`,
  else `DEFAULT_OPENCODE_MODEL`), and the model default live here (one
  place, per the brief).
- `client.ts` (B) — `fetch`-only typed v2 client (works under Node and
  bun): create/get/list/active/delete session, prompt (with `resume`),
  per-session SSE (`after=` replay-then-follow, manual parser, caller-owned
  `AbortSignal`), global bus, history pagination, interrupt, model switch,
  permission reply, question reject. Basic auth on every request. Stream
  open and prompt are concurrent by construction (the SSE-headers timeout
  bounds the lazy-flush window). Non-2xx throws `OpencodeApiError` so
  failures surface as `turn_failed`, never swallowed. Session delete uses
  the v1 compat route (`DELETE /session/:id`) — no v2 delete exists.
- `normalize-opencode.ts` (C) — pure mapping sharing one tool table:
  `normalizeOpencodeHistory` (durable log → `TimelineItem[]` + `TurnUsage`)
  and `mapOpencodeLiveEvent` (one live event → `EventDelta | null`, with
  `OpencodeLiveState`). Reuses `buildDetailFromInput` /
  `attachOutputToDetail` / `summaryFor` after translating opencode's
  camelCase inputs. Tool table: bash→bash, edit→edit, read→read,
  write→write, glob→glob, grep→grep (mode pinned to `"content"` —
  opencode grep has `include`, not `output_mode`), webfetch→web_fetch
  (no `prompt` field server-side; detail prompt left empty),
  websearch→web_search, task→agent (no per-spawn `model` field),
  question→ask_user (`multiple`→`multiSelect`; the tool-result answer
  format matches the existing `parseAskUserAnswers` regex), anything
  else→unknown (keeps the opencode tool name).
- `session-loop.ts` (D) — `ensureOpencodeLoop` / `pushOpencodePrompt` /
  `interruptOpencode` / `deleteOpencodeLoop` / `opencodeColdStart` /
  `shutdownOpencodeLoops`, same contract towards `index.ts`+`router.ts` as
  run-query. One long-lived per-session durable stream (`after=lastSeq`)
  plus global-bus text deltas, both feeding `runtime.addEvent`; activity
  edges (`running`/`idle`) mirror run-query; `resume: true` is sent when a
  previous stream died mid-turn.
- `__fixtures__/` — `text-turn.json`, `tools-turn.json`
  (bash+edit+read), `bash-read-turn.json` (incl. `tool.failed`),
  `interrupted-turn.json`, `text-deltas.json` (live-only deltas), and
  `compaction-turn.json` (synthetic — see below).
- `normalize-opencode.test.ts` — 13 fixture-driven tests (cold: plain
  text, bash+edit+read pairing incl. edit diff + read `structured.content`
  fallback, failed tool, interrupted partial text, compaction divider;
  live: full text-turn delta sequence with client-uuid reuse, missed-delta
  reconcile, recorded-delta replay == durable text, tool call→patch,
  usage stash + compaction lifecycle, ignore-list).
- `host.test.ts` — `agentHost()` default/switch, `resolveOpencodeModel()`
  precedence + slash handling.
- `session-loop.e2e.test.ts` — gated by `THINKITE_E2E_OPENCODE=1`, drives
  one live "pong" turn through the real session loop (below).

New — `packages/daemon/scripts/record-opencode-fixtures.ts`: re-records
the three live fixtures (text / tools / interrupted) against a cheap
model; compaction stays synthetic (route is 503).

Modified:

- `sidecode-sessions.ts` — additive optional `host?: "claude" |
  "opencode"` + `opencodeSessionId?: string` on the metadata (no schema
  change elsewhere), `buildNewSidecodeSession` accepts both, new
  `deleteSidecodeSession()` helper.
- `runtime/session-runtime-manager.ts` — new `attachOpencodeSession()`
  (persist the server-side id onto pre-existing metadata) and
  `removeSession()` (drop runtime + states entry + `onRemove` fan-out for
  `session_state_removed`); `createSessionFromPrompt` forwards the new
  fields. No existing behaviour changed.
- `router.ts` — optional `opencodeHost` / `deleteSidecodeSession` deps
  (unit tests omit them and stay on the Claude path). `sendPrompt`
  branches by stored host metadata, else branch default with a
  Claude-owns-the-id guard (below); `interrupt` prefers the opencode
  loop; `setSessionSelection` switches the server-side model on the
  opencode path; new `deleteSession` case (opencode: server delete +
  metadata + runtime removal; Claude: `unsupported`, i.e. today's
  behaviour — the router previously had no such case).
- `index.ts` — constructs `OpencodeHost`, branches `getMessages` /
  `hasSession` on stored opencode metadata, adds opencode branches to the
  three bridge handlers, stops loops + host before the runtime drain.
  `run-query.ts`, `bridge/*`, and the `@anthropic-ai/claude-agent-sdk`
  dependency are untouched and still covered by their tests.

No new dependencies (Node/bun built-ins only: `fetch`, `AbortController`,
`TextDecoder`, `node:child_process`, `node:crypto`, `node:net`).

## Permissions / questions: mechanism chosen + evidence

Primary: env-injected config
`OPENCODE_PERMISSION={"question":"deny","plan_enter":"deny","plan_exit":"deny"}`,
set on the spawned server in `host.ts`.

- `config.ts` merges `Flag.OPENCODE_PERMISSION` (env) into
  `result.permission`, which becomes user-level config.
- `agent.ts` builds the `build` agent as
  `merge(defaults({"*":"allow",…}), builtin(question:allow,…), user)` and
  `evaluate()` uses findLast — user-level deny wins over the builtin
  `question:allow`.
- `Permission.disabled()` hides denied tools from the model, so the
  question tool is never offered — the same two-step mechanism the
  official CLI uses for non-interactive runs (`cli/cmd/run.ts` passes
  exactly these three deny rules on session create and denies
  `question`/`plan_enter`/`plan_exit`).
- The `build` agent default `"*":"allow"` already auto-allows every other
  tool, giving `bypassPermissions` parity with no per-turn gating.

Backstop: the host's global-bus dispatcher auto-replies any
`permission.v2.asked` with `"once"` (mirrors `opencode run --auto`) and
rejects any `question.v2.asked` (mirrors non-interactive `run.ts`,
which auto-rejects asks without `--auto`). Both event types are in
`ServerDefinitions`, so they arrive on `/api/event`; both reply routes
were verified live (204 on interrupt/model-switch probes; reply routes
share the same group). Neither backstop fired during any probe or the
E2E run (no asks observed with the deny env in place).

## Recorded fixture list

All recorded with opencode 1.18.30, model
`opencode-go/deepseek-v4.1-flash`, project dir a scratch `notes.txt`
setup; scrubbed (no home paths, no tokens; session/message ids are
single-run randoms):

- `text-turn.json` — 6 durable events (prompt.admitted → prompted →
  step.started → text.started → text.ended → step.ended).
- `tools-turn.json` — 35 events; edit (`path`+`oldString`/`newString`),
  two reads, bash, all success; 5 steps.
- `bash-read-turn.json` — 21 events; bash success + read `tool.failed`
  (`error: {type,message}`); 2 steps.
- `interrupted-turn.json` — 8 events; interrupt → 204, then partial
  `text.ended` + `step.failed` (`"Provider turn interrupted"`).
- `text-deltas.json` — 4 live-only `text.delta` bus events for the pong
  turn (replay == durable `text.ended.text`, asserting the merge
  invariant in-test).
- `compaction-turn.json` — SYNTHETIC (marked in-file): manual compact is
  `503 "Session compact is not available yet"` in this version, so no
  live log exists; shapes follow `session-event.ts`
  (`Compaction.Started/Ended`).

## E2E delta sequence (observed, `THINKITE_E2E_OPENCODE=1`)

Prompt "reply with exactly: pong" through `ensureOpencodeLoop` +
`pushOpencodePrompt`, asserted in-test (user append, assistant append,
≥1 `patch_text`, terminal `turn_completed`, folded text contains
"pong"). Observed:

```text
turn_started → append → append → patch_text → patch_text → turn_completed
```

(item 1: `user_message`; item 2: empty `assistant_message`; two live
`text.delta` fragments from the global bus; `turn_completed` with usage
from the terminal `step.ended`). The two `patch_text`s prove both halves
of the stream design: durable replay plus the live-only bus (reconcile
alone can emit at most one patch per text).

Verification status: `bun run typecheck` (all 4 packages) passes,
`bun run test` passes (625 passed, 1 skipped — the E2E gate),
`bun run --cwd packages/daemon build` succeeds, `biome check` is clean
on all touched files, and the E2E above passed twice (pre- and
post-lint).

## What could not be verified

- Real compaction events (route is 503; divider mapping + `0/0` token
  counts ride on the synthetic fixture only).
- `question.v2.asked` auto-reject and `permission.v2.asked` auto-reply
  against a live ask (no ask fired in any run; routes are the documented
  v2 group shapes, reply `"once"` mirrors `--auto`).
- Image attachments: sent as `data:<mime>;base64` `files[]` (the
  server's own inline-blob convention per `session/prompt.ts`), but no
  image turn was run.
- Daemon-restart resume of an opencode turn and server-crash mid-turn
  recovery (`resume: true` path is implemented; only the stream-death
  flag was unit-reasoned, not live-crashed).
- `history` `hasMore` pagination beyond one page (turns here fit in one
  page; the follow loop is written but only single-page exercised).

## Open questions for the maintainer

1. Session identity: the brief asked for the opencode id as
   `cliSessionId`, but the v2 `SessionID` brand requires the `ses_`
   prefix, so a Thinkite UUID cannot be adopted server-side. The mapping
   (`opencodeSessionId` in metadata) achieves the same isolation; ok, or
   should new-session ids be minted opencode-side and returned to the
   clients (needs a protocol field)?
2. Turn-end detection is `activeSessions()` polling (500 ms) + history
   catch-up, because `POST wait` is `503 "not available yet"` and one
   prompt drives N steps. Keep polling, or switch to `wait` if a later
   opencode version enables it?
3. `step.ended` carries `finish` (`"stop"` vs `"tool-calls"`); the loop
   currently ignores it and trusts idleness. Should `"stop"` short-
   circuit the poll?
4. Compaction divider carries `preTokens: 0, postTokens: 0` (opencode
   exposes no counts). Acceptable caption, or suppress the divider until
   counts exist?
5. No-meta sessions whose id exists as Claude JSONL stay on Claude even
   when the branch default is opencode (history safety). Should the
   default instead win and shadow the transcript?
6. Cross-host resume is intentionally unsupported (opencode cannot read
   Claude JSONL and vice versa); `host` pins at creation. Is a
   "migrate session" flow wanted later?

## Discrepancies vs the brief (source/probe wins)

- Brief: `step.ended`/`step.failed` → turn end / `turn_failed`. Live
  logs show 2–5 `step.ended` per prompt (`finish: "tool-calls"`
  mid-turn). Turn end comes from idleness instead; `step.failed` still
  maps to `turn_failed` (swallowed on interrupt).
- Brief: spawn with `--port 0`. The spike gotcha (port 0 once yielded a
  bogus port) is real, so the host allocates an explicit free port and
  passes it; the "listening on" parse + health poll are unchanged.
- Brief: use the opencode id as `cliSessionId`. Impossible per the
  `SessionID` brand (see question 1); metadata mapping instead.
- Brief: `resume: true` on re-prompt after a crash — implemented via a
  stream-death flag rather than unconditionally (normal prompts omit it,
  matching the spike's re-prompt recipe).
- `session.wait` (turn waiter) and `session.compact` are both 503 in
  1.18.30; neither is used.
- `read`/`edit` inputs use `path` in practice (not the documented
  `filePath`); both accepted. `read` success text lives in
  `structured.content` (`content[]` is empty); the extractor falls back
  to it. `question` tool-result compatibility is by format, not yet
  observed live (question tool is denied).
- `deleteSession` had no router case at all (brief implied one existed);
  added, opencode-only.
- Deltas were verified on the v2 `/api/event` bus (not only the legacy
  `/global/event` from the spikes).
