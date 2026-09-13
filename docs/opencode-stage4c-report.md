# Stage 4c report — daemon cleanup: registry-only opencode, no stage-1 host

Done 2026-09-12 on branch `opencode`, verified against the user's registered
Beta desktop service (`0.0.0-beta-19425`).

## What changed

- **The daemon no longer spawns, drives, or normalizes opencode.** Deleted
  `packages/daemon/src/opencode/{host,client,session-loop,normalize-opencode}.ts`
  with their tests, the six 1.18.30 event-log fixtures, and
  `scripts/record-opencode-fixtures.ts` (about 2,700 lines). With them went
  `THINKITE_AGENT_HOST`, `THINKITE_OPENCODE_MODEL`,
  `THINKITE_OPENCODE_API_KEY`, the `OPENCODE_PERMISSION` env recipe and the
  bus backstop that auto-replied permissions / rejected questions — all of
  that was the stage-1 "daemon hosts the turn" model, superseded when
  clients started talking to opencode directly (stages 2–4b).
- **`Daemon.opencode()` is registry discovery only.** `opencode/registry.ts`
  owns `OpencodeConnection` now (`baseUrl / username / password / version`).
  No registered service → the call rejects with "no opencode service is
  running — start the opencode desktop app or `opencode serve --service`",
  which the Electron `/oc` proxy turns into a 502 text and the iroh tunnel
  into a 502 JSON `opencode_unavailable`. The daemon never runs a
  contender against the user's service.
- **Version gate on `/api/health`.** `parseOpencodeVersion` /
  `isSupportedOpencodeVersion`: stable `≥ 2.0.0`, any `0.0.0-beta-N`
  (Beta desktop builds are fast-forward snapshots of `v2`), any
  `0.0.0-dev`; everything else (1.x, unparsable) is refused with
  "opencode X is not supported — Thinkite needs opencode ≥ 2.0.0 (or a v2
  beta build)". The discovery log line also flags an unsupported version.
  Per-session `permission.rules` (2.0.2, absent in beta 19425) is not used
  anywhere yet, so no finer feature gate was added.
- **Router / bridge back to one host.** `RouterDeps` lost `opencodeHost`
  and `deleteSidecodeSession`; `sendPrompt`, `setSessionSelection`,
  `interrupt` and the bridge's inbound-prompt / interrupt / set-model
  handlers are Claude-path only again. The `deleteSession` RPC case is
  gone (it was opencode-only) — the command falls through to the
  `unsupported` default, which is what the pre-stage-1 router test already
  asserts. A `local_*.json` still carrying stage-1 `host: "opencode"`
  metadata is refused on `sendPrompt` (`unsupported`) and reads as an
  empty transcript on `subscribe`, so such an id is never resurrected as a
  Claude session. The metadata fields stay typed as legacy;
  `createSessionFromPrompt` / `buildNewSidecodeSession` no longer accept
  them, and `attachOpencodeSession` / `removeSession` /
  `deleteSidecodeSession` are deleted.
- **Tunnel E2E rewritten on opencode 2.** `iroh-http-tunnel.e2e.test.ts`
  discovers the registered service, then over the iroh HTTP ALPN:
  `/api/health` (pid matches the registration) → `POST /api/session` →
  global `/api/event` SSE aborted after three session events → prompt →
  a fresh SSE (or `session.active` polling if the turn already ended) until
  `session.execution.succeeded` → `message.list` shows the assistant text
  "pong" → `DELETE /api/session/:id` (204). It speaks raw HTTP/1.1 like
  the phone's fetch shim; the desktop `oc-proxy.e2e.test.ts` covers
  `@thinkite/oc-client`.

## What was verified

| Check | Result |
|---|---|
| `bun run typecheck` (5 packages) | clean |
| `bunx vitest run` | 655 passed, 3 skipped (gated) |
| `bunx biome check .` | clean |
| `THINKITE_E2E_IROH_HTTP=1` tunnel E2E | pass, 3.3 s: health 200 (beta 19425) → session → sse#1 3 events, aborted → sse#2 8 events ending `session.execution.succeeded` → "pong" → deleted |
| `iroh-peer-server.test.ts` | one known-flaky connection race failed in the full run, passes in isolation (unchanged file) |

## Still on the daemon RPC (`/rpc`, iroh command ALPN)

Phone: `sendPrompt` / `interrupt` / `setSessionSelection` / `subscribe`
(the old transcript screen — goes away with 3b-2), `subscribeSessions`
(old detail-screen collection), `getGitStatus` / `subscribeGitStatus`,
`getWorkingTreeDiff`, `listDirectory`, `getFilesystemRoots`. Desktop:
`/rpc` for pairing and git status/diff. Claude SDK path (`run-query`,
bridge, `messages/*`) untouched — its removal is a separate decision.

opencode 2 has routes for most of the non-session half (`v2` trunk,
`packages/protocol/src/groups`): `GET /api/vcs`, `/api/vcs/status`,
`/api/vcs/branches`, `/api/vcs/diff`, `/api/vcs/base`; `GET /api/fs/list`,
`/api/fs/find`, `/api/fs/read/*` (all location-scoped by `directory`);
`GET /api/project`, `GET /api/workspace` for the roots picker. What has
no opencode counterpart: the daemon's fs.watch-driven `subscribeGitStatus`
push — the v2 event catalog's only vcs event is the ephemeral
`vcs.branch.updated` (`packages/schema/src/vcs-event.ts`), so working-copy
status would be poll-on-focus or stay a daemon push; pairing; and the
Claude SDK path. Recommendation: do 3b-2 first (phone transcript on
`SessionMessageInfo`), then a "stage 5" that moves git status / diff /
directory listing / roots onto the vcs + fs routes and deletes those RPCs.

## Leftovers

- 3b-2 phone transcript screen on the oc-client rows.
- Stage 5 as above; then the protocol package loses its transcript half.
- The Claude SDK host stays until the user decides on opencode-only.
