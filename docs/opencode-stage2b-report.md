# opencode stage-2b report: TanStack DB adapter lifted into `@thinkite/oc-client/tanstack`

Branch `opencode`. Nothing committed; all changes are in the working tree.
No changes to `packages/app`, `packages/daemon`, `packages/protocol`, or
`spikes/`; no Astryx/Pierre/TanStack version bumps. One new dependency,
`@tanstack/db`, pinned exactly to the copy `@tanstack/react-db` 0.1.92
already resolves (`0.6.14`). This is a lift: the collection sync
contracts, comments, and merge semantics are unchanged.

## What was built (file list)

New — `packages/oc-client`:

- `src/bus.ts` — `SharedBus` moved from the desktop renderer.
  Framework-agnostic: the constructor takes an `OcClient` or a
  `() => OcClient` factory (the desktop passes the lazy singleton, so no
  package-level client import). The reconnect/backoff semantics and the
  subscriber-failure guards are the same as before; the "why one bus
  serves the whole app" comment moved with it.
- `src/model-ref.ts` — `parseModelRef` / `formatModelRef` moved from
  `desktop/src/lib/oc.ts` (main-entry export).
- `src/tanstack/sessions.ts` — `createSessionsCollection({ client, bus })`
  returning the session-states collection; `SessionRow` exported.
- `src/tanstack/transcript.ts` — `createTranscriptCollections({ client,
  bus })` returning `{ get, evict, sendUserMessage }`; `OrderedOcRow`
  and `SendMessageVars` exported.
- `src/tanstack/status.ts` — the session-status registry, package-internal
  (not re-exported from `./tanstack`): transcript publishes, sessions
  subscribes, no sessions↔transcript import either way.
- `src/tanstack/index.ts` — the `@thinkite/oc-client/tanstack` entry.
- `src/tanstack/transcript.test.ts`, `src/tanstack/sessions.test.ts` —
  colocated vitest suites (below).

Modified:

- `packages/oc-client/src/index.ts` — also exports `SharedBus` and
  `formatModelRef` / `parseModelRef`.
- `packages/oc-client/package.json` — `"./tanstack"` export mirroring
  `"."` (types → dist, bun → src, node → dist, default → src);
  `@tanstack/db: "catalog:"` dependency.
- root `package.json` — catalog entry `"@tanstack/db": "0.6.14"` (the
  exact version `@tanstack/react-db@0.1.92` pins).
- `packages/desktop/src/lib/oc.ts` — shrunk to `getOcClient()` +
  `sharedOcBus = new SharedBus(() => getOcClient())` + the collection
  singletons (`sessionStateCollection`, and
  `getTranscriptCollection` / `evictTranscriptCollection` /
  `sendUserMessage` destructured from the transcript factory); HMR
  dispose retained.
- desktop import sites — `SessionSidebar.tsx`, `TranscriptPanel.tsx`,
  `routes/index.tsx`, `routes/session/$sessionId.tsx` now point at
  `lib/oc.ts` for singletons and `@thinkite/oc-client/tanstack` for row
  types; `$sessionId.tsx` takes model refs from the main entry.

Deleted (desktop):

- `packages/desktop/src/lib/sessions-collection.ts`
- `packages/desktop/src/lib/transcript-collections.ts`
- `packages/desktop/src/lib/session-status.ts`

`bun.lock` gained two lines (the oc-client catalog ref + the catalog
entry). No other package changed.

## Public API of `./tanstack`

```ts
import type { Collection, Transaction } from "@tanstack/db";
import type { OcClient, SharedBus } from "@thinkite/oc-client";

export type SessionRow = {
  id: string;
  title: string;
  directory: string;
  model: string | null;
  updatedAt: number;
  activity: "running" | "idle";
};

export type OrderedOcRow = OcRow & { _order: number };

export function createSessionsCollection(options: {
  client: OcClient;
  bus: SharedBus;
}): Collection<SessionRow, string>;

export function createTranscriptCollections(options: {
  client: OcClient;
  bus: SharedBus;
}): {
  get(sessionId: string): Collection<OrderedOcRow, string>;
  evict(sessionId: string): void;
  sendUserMessage(variables: {
    sessionId: string;
    userMessageUuid: string;
    text: string;
  }): Transaction;
};
```

Row shapes (unchanged): `SessionRow = { id, title, directory, model:
string | null, updatedAt, activity: "running" | "idle" }`;
`OrderedOcRow = OcRow & { _order: number }` (reducer union + tail index).
`SharedBus` (main entry) exposes `subscribe(fn): () => void`.

Runtime files import only `@tanstack/db` and the pure oc-client modules —
audited for `node:*`, DOM-only globals, and `Buffer` (none); TanStack DB
itself is Hermes-safe. Not executed on Hermes in this stage.

## Exactly one `@tanstack/db`

- `bun pm ls --all` lists a single `@tanstack/db@0.6.14`; the only
  physical copy is `node_modules/@tanstack/db` (no nested copies under
  any package).
- `require.resolve("@tanstack/db", { paths: ["packages/oc-client"] })`
  and `require.resolve(..., { paths:
  ["node_modules/@tanstack/react-db"] })` return the same
  `node_modules/@tanstack/db/...` path (repo-relative), and
  `import.meta.resolve` from `@thinkite/oc-client/tanstack` resolves to
  the same `dist/esm/index.js`.
- Runtime guard: a collection created through
  `createSessionsCollection` from the package is
  `instanceof CollectionImpl` imported from `@tanstack/db` — the check
  `useLiveQuery` performs — so `react-db` accepts it.

## Tests

Colocated under `packages/oc-client/src/tanstack/`, run by the root
vitest config. Both suites drive a hand-rolled fake `OcClient` (history
pages + a push-driven async-iterable session stream; `prompt` returns a
deferred so the optimistic window is controlled) and a fake bus that
fans out synchronously. No alias needed: the suites import the source
relatively (`./transcript.ts`), so the vitest `node` condition never
resolves `@thinkite/oc-client` to `dist` for them, and no pretest build
is required. (External by-name consumers, including the gated desktop
E2E, still resolve to `dist` — see open question 1.)

Transcript (`transcript.test.ts`, 3):

1. mirrors history and patches rows in place by identity — history
   inserts user `_order 0` / streaming text `_order 1`; a live bus
   `text.delta` patches the text without changing `_order`; the durable
   `text.ended` lands on the same key; a `text.delta` for another
   `sessionID` is ignored.
2. re-opens the stream with `after=lastSeq` — history seqs 1–2 → first
   `openSessionStream` sees `after=2`; a durable seq-10 event advances
   `lastSeq`, the stream ends, and the re-open (after the backoff) sees
   `after=10`.
3. keeps one optimistic user row, replaced by `prompt.admitted` —
   `onMutate` paints synchronously, `prompt` is called with the
   client-minted id, the durable admitted event (same `messageID`,
   different server text) converges the row, size stays 1.

Sessions (`sessions.test.ts`, 3):

1. mirrors list pages and `session.created/updated/deleted` events.
2. derives busy/idle from step events and the active seed — one-shot
   `/api/session/active` seed, `step.ended`, `step.started`,
   `finish: "tool-calls"` continuation, `step.failed`, and an unrelated
   delta leaving state alone.
3. lets the durable transcript status override a stale bus reading —
   the bus reports `step.started` and "drops" the end (row stuck
   running); the transcript's durable stream replays the start from
   history and delivers the end, whose status change publishes idle
   through the registry into the sessions row.

## Verification status

- `bun run --cwd packages/oc-client build` green (dist emits
  `dist/tanstack/*` with rewritten `.js` specifiers).
- `bun run typecheck` green (protocol, daemon, desktop incl. server
  tsconfig, app, oc-client).
- `bun run test` green: 653 passed, 2 skipped (the two live E2E gates),
  37 files — 6 new tests plus the existing 647-pass suite.
- `bun run --cwd packages/desktop build` green (renderer + Electron main).
- `biome check .` clean (232 files).
- `bun run --cwd packages/desktop dev` boots: Vite ready on 5183, the
  main bundle compiled, the in-process daemon came up and Electron
  started; the run was terminated after ~22s so no window was
  interacted with (maintainer does window runs).

## What could not be verified

- UI behaviour past typecheck/build/dev-compile: sidebar live updates,
  delete button, transcript rendering/streaming, model picker — same
  gap as stage 2; the renderer-side logic is covered at the collection
  level by the new tests.
- The gated live opencode E2E (`THINKITE_E2E_OPENCODE=1`) was not run
  (needs a provider); the two skipped tests are those gates.
- Hermes/Expo execution of `./tanstack` (stage 3). The entry is written
  to the same constraints as the main one and only depends on
  `@tanstack/db` + pure modules, but it was only exercised under
  node/bun/vitest/Vite.
- Multiple session-list pages (`nextCursor` loop) and `history.hasMore`
  pagination: covered by the pre-existing reducer tests' shapes, not by
  the new fake client (which returns one page).

## Open questions

1. Source-vs-dist for tests: this change keeps tests importing source
   relatively, so vitest sits at the source layer, but desktop
   `typecheck`/`build` resolve `@thinkite/oc-client` and `/tanstack`
   types through `exports` → `dist`. A clean tree therefore still needs
   `bun run --cwd packages/oc-client build` before desktop typecheck
   (already true for the main entry since stage 2). Wire oc-client build
   into `typecheck`, add a vitest alias to source, or leave as is?
2. HMR: `desktop/src/lib/oc.ts` still nulls the client singleton on hot
   dispose, but the collection singletons now capture their client at
   creation. A hot reload of that module creates a fresh collection set
   and leaves the old one to gc. Production is unaffected; is the dev
   wart acceptable, or should the collections be disposed in the HMR
   hook?
3. The status registry is still a single global sink (the desktop has
   exactly one sessions collection). If a later stage runs two
   collections in one process, the last registration wins. Promote it to
   a subscriber set then, or now?
4. `./tanstack` does not re-export raw `@tanstack/db` primitives
   (`Collection`, `Transaction`); apps import those from `@tanstack/db`
   directly. Keep the entry minimal, or re-export to keep consumers off
   the transitive dep?
