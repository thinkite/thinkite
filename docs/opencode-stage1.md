# opencode host — stage 1: swap the agent host, keep the wire protocol

You are working in the Thinkite monorepo (Apache-2.0, bun workspaces, TypeScript 6
defaults, ESM with NodeNext `.ts` import specifiers, zod v4, vitest, biome).
Branch: `opencode`. Do NOT commit; leave changes in the working tree.

## Goal

Replace the Claude Agent SDK as the agent host inside `packages/daemon` with a
locally spawned `opencode serve` (opencode 1.18.30, on PATH as `opencode`),
driven through its **v2 HTTP API** (`/api/...`). The daemon keeps speaking the
existing Thinkite wire protocol (`packages/protocol/src/index.ts`) to the two
frontends, so `packages/app` (iOS) and `packages/desktop` (Electron) must not
need any change. Success = a real turn streams end-to-end through the daemon
with opencode as the host, and all existing tests still pass.

Keep the old host reachable behind an env switch so the diff is reversible:
`THINKITE_AGENT_HOST=claude|opencode`, default `opencode` on this branch.
Do not delete `run-query.ts`, the `bridge/*` modules, or the
`@anthropic-ai/claude-agent-sdk` dependency in stage 1. They stay compiling and
keep their tests; they are simply not on the opencode path.

## Read first (in this order)

1. `spikes/oc-proxy/README.md` — findings and gotchas from three passing spikes
   against this exact opencode version. Every gotcha there is real.
2. `spikes/oc-proxy/daemon-side.ts` (`spawnOpencode`), `spikes/oc-proxy/run.ts`,
   `spikes/oc-proxy/run-merge.ts`, `spikes/oc-proxy/debug-v2*.ts` — working
   request/response shapes for spawn, health, v2 create, prompt, event stream
   (`?after=N` replay-then-follow), history, resume. Reuse these shapes.
3. `packages/protocol/src/index.ts` — the target shapes you must produce:
   `TimelineItem`, `ToolCallItem`, `ToolCallDetail`, `EventDelta`, `TurnUsage`,
   `SessionState`, `SessionActivity`. Read their doc comments; they encode the
   invariants the frontends rely on (uuid stability, `append`/`patch_text`/
   `patch_tool_call` semantics, compact divider, turn end).
4. `packages/daemon/src/runtime/run-query.ts` — what you are replacing. Its
   header comment documents exactly which SDK message becomes which
   `EventDelta`. Mirror that contract from opencode events instead.
5. `packages/daemon/src/messages/normalize.ts`, `tool-detail.ts`, `fold.ts` and
   their tests — cold-start normalization and the tool-detail builders
   (`buildDetailFromInput`, `attachOutputToDetail`, `summaryFor`). Reuse the
   detail builders; they are keyed by tool name + input object.
6. `packages/daemon/src/index.ts` and `packages/daemon/src/router.ts`
   (`sendPrompt`, `subscribe`, `interrupt`, `subscribeSessions`,
   `setSessionSelection`, `deleteSession`) — the wiring you must redirect.
7. `packages/daemon/src/runtime/session-runtime.ts` + `session-runtime-manager.ts`
   — the per-session ring buffer / activity / teardown machinery. Keep it; the
   opencode host feeds it exactly like run-query does today.
8. opencode source (read-only reference, sibling checkout at `../opencode`,
   same version as the installed binary): `packages/protocol/src/groups/session.ts`
   (v2 routes), `packages/schema/src/session-event.ts` (durable
   `session.next.*` event types), `packages/opencode/src/core/src/session/runner/*`,
   `packages/opencode/src/cli/cmd/run.ts` (how the official CLI drives a turn and
   handles permissions non-interactively).

## Deliverables

### A. `packages/daemon/src/opencode/host.ts` — process supervisor
- Spawn `opencode serve --port 0 --hostname 127.0.0.1` with a random
  `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME`, `OPENCODE_CLIENT=thinkite`.
  Parse the "listening on" line for the port, poll `/global/health` until ready.
- Lifecycle: start lazily on first need (or at daemon start — your call, document
  it), stop on `daemon.stop()`, log exits; a simple restart-on-crash with backoff
  is welcome but optional.
- Credentials: the v2 runner reads provider credentials from opencode's own
  integration store (SQLite) or `OPENCODE_API_KEY`, NOT from `auth.json` (see
  README gotcha). Do not read `~/.local/share/opencode/auth.json`, `opencode.db`,
  or `~/.config/opencode/*` from daemon code. Pass through
  `THINKITE_OPENCODE_API_KEY` → `OPENCODE_API_KEY` if set; otherwise rely on the
  user's opencode integration state. If the model is unavailable, surface it as
  a `turn_failed` EventDelta with the error text — never swallow it.
- Permissions: stage-1 parity with the current `bypassPermissions` +
  `AskUserQuestion` disallowed behaviour in run-query.ts. Find the right
  opencode mechanism (config `permission` rules / env-injected config /
  auto-replying to `permission.v2.*` via the API — verify in the opencode source)
  so no turn ever blocks on a permission or question. Document which mechanism
  you used and why.

### B. `packages/daemon/src/opencode/client.ts` — typed v2 client
Thin `fetch`-based client (Node ≥ 24; daemon runs under Node in production,
`bun --watch` in dev — use only APIs that work in both). Cover: create session,
prompt (with `resume`), event stream (SSE, `after=` replay-then-follow, manual
parser, abort via AbortController), history, abort/interrupt a running turn,
list sessions, delete session. Basic auth header on every request. Note the
lazy-SSE-headers gotcha: open the stream and send the prompt concurrently.

### C. `packages/daemon/src/opencode/normalize-opencode.ts` — pure mapping
Two pure functions sharing one tool mapping table:
1. durable event log (`session.next.*[]`, as returned by history/replay) →
   `TimelineItem[]` (cold start, the counterpart of `normalize()`), plus a
   `TurnUsage` extractor if opencode exposes usage on `step.ended`/`prompted`.
2. one live event → `EventDelta | null` (streaming, the counterpart of the
   run-query consumer loop). Text: `text.started` → `append assistant_message`
   with empty text, `text.delta` (live-only, from the global event stream) →
   `patch_text`, `text.ended` carries the full text — use it to reconcile.
   Tools: `tool.called`/`tool.input.*` → `append tool_call running` with detail
   from `buildDetailFromInput`; `tool.success`/`tool.failed` → `patch_tool_call`
   with `attachOutputToDetail`. `compaction.*` → `compact_divider`.
   `step.ended`/`step.failed` → turn end / `turn_failed`. `agent.switched`,
   `model.switched` → `session.updated` if the protocol has a slot, else ignore.
Tool name mapping (opencode → Thinkite detail type): bash→bash, edit→edit,
read→read, write→write, glob→glob, grep→grep, webfetch→web_fetch,
websearch→web_search, task→agent, question→ask_user, anything else→unknown.
Verify opencode's actual tool input field names against
`../opencode/packages/opencode/src/tool/*.ts` before mapping; do not guess.
Tests: record real event logs from a live opencode session into
`packages/daemon/src/opencode/__fixtures__/*.json` (a small script under
`packages/daemon/scripts/` is fine) and drive the pure functions from those
fixtures with vitest. Cover: plain text turn, a turn with bash + edit + read,
an interrupted turn, and (if you can trigger it cheaply) a compaction.
Strip anything personal from fixtures (home paths, tokens) before saving.

### D. Wire it in
- `packages/daemon/src/opencode/session-loop.ts` (or similar): the opencode
  counterpart of `ensureSessionLoop` / `pushPrompt` / interrupt. Same public
  contract towards `index.ts` + `router.ts` so the call sites only branch on
  `THINKITE_AGENT_HOST`. One long-lived event stream per active session feeding
  `runtime.addEvent`; activity transitions (`running`/`idle`) mirror what
  run-query does today; `resume: true` on re-prompt after a crash.
- Session identity: Thinkite's sidecode metadata (`sidecode-sessions.ts`) keys
  sessions by `cliSessionId`. Use the opencode session id as `cliSessionId` for
  opencode-hosted sessions and record `host: "opencode"` in the metadata so the
  two hosts never collide. `hasSession` / cold-start `subscribe` go through the
  v2 history route for opencode sessions.
- Model: `sendPrompt.model` / `setSessionSelection` carry a string. For the
  opencode host interpret `providerID/modelID` (split on the first `/`); if
  absent, use `THINKITE_OPENCODE_MODEL` env, falling back to one constant in
  `host.ts`. Keep it one place.
- `cwd` → `location.directory` on session create.
- Delete session → opencode delete (cascades its events) + our metadata.

### E. Verification
- `bun run typecheck` and `bun run test` at the repo root must pass.
- Add an integration test gated by `THINKITE_E2E_OPENCODE=1` that spawns the real
  `opencode serve`, drives one prompt ("reply with exactly: pong") through the
  daemon's session loop and asserts the EventDelta sequence (user_message
  append, assistant_message append, ≥1 patch_text, turn end, final text
  contains "pong"). Run it yourself with a cheap model and paste the observed
  delta sequence into the report.
- `bun run --cwd packages/daemon build` must succeed (production is Node).

### F. Report
Write `docs/opencode-stage1-report.md`: what you built (file list), which
opencode mechanism you chose for permissions/questions and the evidence,
the recorded fixture list, the E2E delta sequence, anything you could not
verify, and open questions for the maintainer. Keep it factual; no local
absolute paths in the report.

## Rules
- Do not modify `packages/app`, `packages/desktop`, `packages/signaling`,
  `packages/website`. Do not change existing zod schemas in `packages/protocol`
  except strictly additive optional fields, and only if you cannot avoid it —
  say so in the report.
- Do not run `git commit`, `git push`, or rewrite history.
- Do not read or copy credential files (`auth.json`, `opencode.db`,
  `~/.config/opencode`, keychain). Do not print environment variables.
- Do not install new dependencies without a one-line justification in the
  report; prefer Node built-ins.
- Comments in English, in the same voice as the surrounding code (short
  "why" comments, references to files by relative path).
- When the opencode source contradicts the spike README, the source wins —
  note the discrepancy in the report.
