# opencode stage 2b: lift the TanStack DB adapter into `@thinkite/oc-client/tanstack`

You are working in the Thinkite monorepo (Apache-2.0, bun workspaces, TypeScript 6
defaults, ESM with NodeNext `.ts` import specifiers, vitest, biome, React 19,
TanStack DB). Branch: `opencode`. Do NOT commit; leave changes in the working tree.

## Context

Stage 2 (`docs/opencode-stage2-report.md`) made the desktop renderer consume
opencode v2 through `packages/oc-client` (`@thinkite/oc-client`: SDK wrapper +
pure reducers, no framework deps). The glue that turns reducer output into
TanStack DB collections currently lives in the desktop app:

- `packages/desktop/src/lib/oc.ts` — `SharedBus` (one `/api/event` connection,
  fan-out to subscribers, reconnect with backoff), `getOcClient()` singleton,
  `parseModelRef` / `formatModelRef`.
- `packages/desktop/src/lib/sessions-collection.ts` — `sessionStateCollection`
  (`createCollection` sync handler: list pages + bus events → rows, busy/idle
  via `ocStatusTransition`, one-shot `/api/session/active` seed).
- `packages/desktop/src/lib/transcript-collections.ts` — per-session
  collection cache (`getTranscriptCollection`, `evictTranscriptCollection`),
  history pages then durable stream with `after=` resume + bus routing, row
  mirror by object identity, `sendUserMessage` optimistic action.
- `packages/desktop/src/lib/session-status.ts` — registry so the open
  session's durable stream publishes busy/idle into the sessions row (the bus
  alone dropped a `step.ended` once and wedged the composer).

The iOS app (stage 3, not in scope here) will need exactly the same glue. Goal:
move it into oc-client as a `./tanstack` entry so both apps only do
`useLiveQuery`. Behaviour must stay identical — this is a lift, not a redesign.

## Deliverables

### A. `packages/oc-client/src/bus.ts`
Move `SharedBus` here (framework-agnostic already). Constructor takes the
`OcClient` (or a factory) instead of importing a desktop singleton. Export it
from the main entry. Keep the reconnect/backoff semantics and the comment
explaining why one bus serves the whole app.

### B. `packages/oc-client/src/tanstack/` — new entry `@thinkite/oc-client/tanstack`
- `sessions.ts`: `createSessionsCollection({ client, bus })` → the collection
  currently defined in `sessions-collection.ts`, row type exported.
- `transcript.ts`: `createTranscriptCollections({ client, bus })` → an object
  with `get(sessionId)`, `evict(sessionId)`, and `sendUserMessage` (the
  optimistic action), i.e. what `transcript-collections.ts` exports today.
- `status.ts`: the session-status registry, now internal to the package (the
  transcript collection publishes, the sessions collection subscribes); keep
  it acyclic.
- `index.ts` re-exporting the above. `parseModelRef`/`formatModelRef` move to
  the main entry (`packages/oc-client/src/model-ref.ts`).
- Dependency: `@tanstack/db` (NOT `@tanstack/react-db`). It must resolve to
  the SAME package instance `@tanstack/react-db` uses (react-db 0.1.92 pins
  `@tanstack/db` 0.6.14); a second copy would make `useLiveQuery` reject the
  collections. Add `@tanstack/db` to the root `package.json` catalog at the
  exact version react-db resolves, reference it as `catalog:` from oc-client,
  run `bun install`, and verify with `bun pm ls` / a `require.resolve` check
  that exactly one `@tanstack/db` is installed.
- `package.json` `exports`: add `"./tanstack"` mirroring the existing `"."`
  entry (types + bun/src + node/dist + default/src). Keep the runtime entry
  Hermes-safe: no `node:*`, no DOM globals, no `Buffer` (TanStack DB itself is
  fine on Hermes).

### C. Desktop wiring
`packages/desktop/src/lib/oc.ts` shrinks to the two singletons
(`getOcClient()`, `sharedOcBus = new SharedBus(...)`) plus the collection
singletons created from the `./tanstack` factories; `sessions-collection.ts`,
`transcript-collections.ts`, `session-status.ts` are deleted and every import
site (`SessionSidebar.tsx`, `TranscriptPanel.tsx`, `routes/index.tsx`,
`routes/session/$sessionId.tsx`) points at the new modules. No behaviour
change in the UI.

### D. Tests
- Move the collection logic under test: with a fake `OcClient` (history
  pages + async-iterable session stream) and a fake bus, assert for the
  transcript collection: rows mirror the reducer (insert/update by identity),
  `after=` resume re-opens from `lastSeq`, a bus `text.delta` for another
  session is ignored, `sendUserMessage` inserts an optimistic user row that is
  replaced (same key) by `prompt.admitted`; for the sessions collection: pages
  + `session.created/updated/deleted`, busy/idle from step events, the
  status registry overriding a stale bus reading. vitest, colocated
  `*.test.ts`. Note: vitest's `node` condition resolves `@thinkite/oc-client`
  to `dist` — run `bun run --cwd packages/oc-client build` before the suite,
  or add a vitest alias to `src` (say which in the report).
- `bun run typecheck`, `bun run test`, `bun run --cwd packages/desktop build`
  green; `biome check` clean on touched files.
- `bun run --cwd packages/desktop dev` must boot (Vite + Electron main compile);
  a window run is done by the maintainer.

### E. Report → `docs/opencode-stage2b-report.md`
File list, the public API of `./tanstack` (TypeScript excerpt), how you
verified single-instance `@tanstack/db`, test list, anything not verified,
open questions. No local absolute paths.

## Rules
- Do not modify `packages/app`, `packages/daemon`, `packages/protocol`,
  `spikes/`. Do not upgrade Astryx, Pierre, or TanStack versions.
- Do not run `git commit` / `git push`. Do not read credential files
  (`auth.json`, `opencode.db`, `~/.config/opencode`). Do not print env vars.
- New dependencies: only `@tanstack/db` as described.
- Comments in English, in the voice of the surrounding code; keep the existing
  "why" comments when you move code.
