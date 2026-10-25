# Preview tool v1 — servers the agent starts, opened from desktop and phone

The agent starts dev servers and APIs through four tools the daemon serves
to opencode. The daemon keeps a registry of what is running, the desktop
opens the pages in its browser panel, and the phone reaches every
registered port through the iroh TCP tunnel from the `forward-tcp-spike`
branch. Letting the agent look at pages itself (screenshots, snapshots,
clicks) is a separate, later piece: thinkite/thinkite#31.

## Goal

- Agent-side: `thinkite_preview_start`, `_list`, `_logs` and `_stop`, served
  by the daemon over opencode's client MCP. Every long-running server the
  agent starts, page or API, goes through them.
- The daemon's registry is the one list of running servers per project.
  Desktop and phone subscribe to it.
- Desktop: a server started with `open: true` opens as a tab in the
  session's browser panel. The info panel lists the project's servers, with
  a stop button for each.
- Phone: a preview screen for the session's project. While it is visible,
  every running registered port is forwarded, so a page can call its API on
  another port (the case in the 10-24 test, where the page fetched
  `localhost:8080`). The screen has a port switcher and manual port entry.

## Non-goals

- No browser tools for the agent (thinkite/thinkite#31).
- No automatic discovery of servers the agent or the user started some other
  way (nohup, the user's own terminal). Manual port entry on the phone
  covers those. Process-tree discovery was measured on 10-24 and can be
  added later.
- No multi-tab phone browser. One page at a time, with a switcher.
- No `PORT` injection. Vite ignores `PORT`, and when a port is taken the
  model reads the error from the result and picks another, as it did in the
  test.
- The desktop/phone UI does not start servers. Starting is the agent's job.
- No launch configuration file. If the UI ever gets a "start web" button,
  that needs Thinkite's own file (for example `.thinkite/launch.json`),
  not Claude Code's `.claude/launch.json`.

## What the 10-24 experiment settled

Stub tools served over client MCP, opencode 2.1.4 isolated serve, DeepSeek
V4.1 Flash Free, Vite web / Bun API / Next.js test projects, 4 prompts × 2
arms plus lifecycle runs.

| Finding | Consequence for v1 |
|---|---|
| 9/9 long-running servers went through `preview_start`; none through shell background or nohup | Tools alone are enough; no discovery fallback in v1 |
| API-only prompt: `preview_start` with `PORT=8080`, `open: false` | Backends get registered, and the phone forwards their ports |
| `open: true` only for "let me see" prompts; false for checks and APIs | Keep `open` as a model decision |
| A second start of the same name with `open: true` restarted the server and hit "port in use" | Start is idempotent per name (below) |
| The stub's list showed servers from earlier sessions that were already dead | List checks liveness and filters by session |
| Restarting the stub lost its in-memory registry while the servers kept running | Rebuild the registry from `/api/shell` metadata |
| `instructions` in the MCP initialize reply never reached the model | Tool descriptions are the only channel |
| Code Mode shows only the first line of each description, cut at 120 characters | Each first line has to stand on its own (below) |
| Each attach/detach injects a ~8.6–8.9k character "catalog changed" notice (anomalyco/opencode#55529) | One persistent connection per directory |
| Tools attached to `proj/web` are invisible to a session at `proj` | Attach to every session's exact directory |
| In Code Mode the call is nested in an `execute` tool row | Clients learn about previews from the registry, not from transcript rows |

Two facts from opencode's shell code (`packages/core/src/shell.ts` on
`dev`): a shell created without `timeout` never times out, and server
teardown ends every running shell, and each shell publishes exactly one
`shell.exited`.

## Architecture

```
opencode service ──client MCP (WS, per directory)── daemon: PreviewHost
      │  POST/GET/DELETE /api/shell, shell.exited events      │
      │                                                       ├─ Registry (per directory)
      ▼                                                       ├─ router: subscribePreviews, stopPreview
  dev servers on the Mac's loopback                           ▼
      ▲                                          desktop (in process) / phone (iroh RPC)
      └── thinkite/tcp/1 (IrohTcpTunnel) ◄── phone forwardTcp listeners
```

`PreviewHost` lives in `packages/daemon`, not the desktop, so the tools
work under `thinkite up` too. New files:

```
packages/daemon/src/preview/
  host.ts       connection per directory, tool handlers
  registry.ts   entries, idempotency, rebuild, liveness
  ports.ts      process tree → listening ports (ps + lsof -a -p)
  tools.ts      names, descriptions, input schemas
```

## Tools

Tools are named `thinkite_<tool>` (the client name is `thinkite`). In Code
Mode the model calls them as `tools.thinkite.preview_start(…)`. Every call
carries `_meta["ai.opencode/sessionID"]`.

The first lines below are the whole guidance the model sees in the catalog.
Lengths are measured and must stay under 120 characters.

| Tool | First line of the description | Length |
|---|---|---|
| `preview_start` | Run a dev server or API in the background so the user can open it (use this, not shell background/nohup). | 105 |
| `preview_list` | List servers started with preview_start: URL, status, and whether it was shown to the user. | 91 |
| `preview_logs` | Show the recent output of a server started with preview_start. | 62 |
| `preview_stop` | Stop a server started with preview_start and free its port. | 59 |

`preview_start` continues, after the first line (what the stub said):
"Use for any long-running process the user or a page reaches over the
network: web dev servers, API servers, websocket servers. Servers started
with the shell tool's background mode or nohup are invisible to the user's
phone. Set open: true only for a page the user should look at in a browser;
leave it false for APIs and other backends. Returns the URL once the port is
listening."

### `preview_start({ name, command, cwd?, open? })`

- `name` is the key, unique per directory. A server is a project resource, so
  a second session asking for the same name gets the running one.
- Idempotent:
  - **Same name, running, same command:** no restart. Add the caller's
    session to the entry's `sessions`. If `open` is true, stamp the entry's
    `opened` again (below). Return the current URL.
  - **Same name, running, different command:** return an error result:
    "`web` is already running `<command>`; call preview_stop first to change
    it." Never kill a server implicitly.
  - **Same name, exited, or new:** create a new shell and replace the entry.
- `command` is required. In every test run the model read
  `package.json` and wrote the command itself, so v1 reads no launch
  configuration. A reopen of a running name may omit it.
- Start: `shell.create({ command, cwd, metadata: { thinkite: { preview:
  name, open, session } } })` with `location.directory`, and no `timeout`.
- Wait for a port (see `ports.ts` below), at most 30 s:
  - **Listening:** return `"<name>" is running at http://localhost:<port>`
    (other ports listed). Add "Sent to the user's preview pane" or
    "Registered (not opened)". The words matter: in the test the model used
    this result to decide what to say to the user. They must not claim more
    than the daemon knows: it sees the request, not the user's tabs.
  - **Exited first:** an error result with the status, the exit code and
    the last 40 lines of output. The entry stays as `exited`, so logs keep
    working.
  - **30 s with no port:** an error result saying so ("check preview_logs").
    The entry stays as `starting`, and detection keeps polling in the
    background for 2 more minutes, pushing to clients when a port appears.

### `preview_list({ all? })`

- Default: entries whose `sessions` include the caller. `all: true` lists
  the whole directory. Either way, end with "N more in this project (pass
  all: true)" when some are hidden.
- Re-check each entry before answering: shell status from `shell.get`, and
  ports still listening for the shell's process tree. States: `starting`,
  `running`, `running (no port listening)`, `exited (code)`, `killed`.

### `preview_logs({ name, lines? })`

- `shell.output` with `limit`; default 40 lines, at most 200. Strip ANSI.
- Works on exited entries (opencode keeps the last 25 exited shells).

### `preview_stop({ name })`

- `shell.remove`, which kills the process tree. Confirm the ports are free,
  then mark the entry `killed`. It stays, so its logs remain readable and
  clients can show it stopped; a later start of the name replaces it.
- Stopping an entry that already ended answers "not running (exited)".
- If the entry has other sessions, say so in the result: the server
  stopped for them too.
- Stop never touches the user's tabs (see Desktop). Pages already loaded
  stay on screen; when the agent starts the name again on the same port,
  the dev server's client reconnects on its own.

## Registry

```ts
type PreviewEntry = {
  directory: string;
  name: string;
  shellID: string;
  pid?: number;
  command: string;
  cwd: string;
  ports: number[];          // all listening ports of the process tree
  primaryPort?: number;     // the first one that answers HTTP
  opened?: { at: number; sessionID: string }; // latest request to show it
  sessions: string[];       // starter first
  status: "starting" | "running" | "exited" | "killed" | "timeout";
  startedAt: number;
};
```

- **The source of truth is opencode's shells.** The registry is a cache that
  can always be rebuilt. On attach, and on every reconnect, run
  `shell.list({ location: { directory } })`. Running shells with
  `metadata.thinkite.preview` become entries again: re-detect their ports,
  restore `session` from the metadata, and `opened` (stamped at the shell's
  start) when `open` was set. Entries whose shells are gone are marked
  ended, not dropped.
- **Liveness:** subscribe to the event bus (the daemon already has
  `client.event`). On `shell.exited` for a known shell, update the entry
  and push to clients. `preview_list` and the clients' subscribe also
  re-check, in case an event was missed.
- A daemon restart loses what only lived in memory, and v1 accepts both:
  - sessions that reused a server after its starter, so their
    `preview_list` needs `all: true` to see it;
  - a later request to open it (shell metadata is written once, at
    create). The rebuilt stamp is the shell's start, older than what any
    device already handled, so nothing reopens;
  - entries of servers that had already ended (`shell.list` returns
    running shells only).
- No persistence of our own. While the opencode service runs, the servers
  and their metadata are there to rebuild from; when it restarts, its
  shells end and there is nothing left to show. If the losses above ever
  matter, write them back into the shell's metadata once opencode can
  update it, so opencode stays the one source. A sidecar file in the
  Thinkite home is the fallback.

## Client MCP connection

- One connection per distinct session directory, opened the first time the
  daemon sees the directory:
  - at start, from the recent-sessions list (`opencode/recent.ts`);
  - after that, from session events on the bus.
- The connection stays open for the daemon's lifetime. Nothing a client does
  closes it: not the phone going to the background, not a window closing,
  not a session ending. Every detach costs each session in that directory a
  ~9k character catalog notice.
- Reconnect with backoff (the `connectClientMcp` pattern: 0.5 s doubling to
  10 s) and run the registry rebuild after each reconnect. An opencode
  service restart kills the shells, so the rebuild finds them gone and
  clients see them stop.
- Implement the WebSocket MCP server ourselves (about 100 lines, as in the
  stub). The `@opencode/client/mcp` helper would also work, but we need the
  connection events for the rebuild, and we don't send `instructions`.
- Attaching before a session's first turn avoids the notice: verified
  10-25. The host attached on `session.created` about 1 ms after the
  event, and the first turn had the tools with no "catalog changed"
  message.
- Protocol version: speak 2025-11-25 only. opencode supports 2026-07-28
  since anomalyco/opencode#48937, but pins attached connections to the
  legacy handshake (`packages/core/src/mcp/client.ts`: `config.type ===
  "attached" ? "legacy"`). Follow `connectClientMcp` if that changes.

## Port detection (`ports.ts`)

- Poll every 250 ms while waiting:
  1. `shell.get` for the status and pid;
  2. the pid's descendants from `ps -axo pid=,ppid=`;
  3. `lsof -a -p <pids> -nP -iTCP -sTCP:LISTEN -Fn`.
- Measured 10-24: Vite, Next.js and `bun --hot` are found 0.1–1.4 s after
  the shell starts. Per-pid lsof costs about 20 ms, and so does `ps`.
- `primaryPort`: the first port whose `GET /` answers, with a 1.5 s timeout,
  so a debugger or other side port isn't the one opened. No page/API
  classification: whether to show a server is the agent's `open`.

## Clients

### Protocol (`@thinkite/protocol`, patch bump, additive frames)

- Same shape as git status: `getPreviews { directory }` is the snapshot,
  `subscribePreviews { directory }` a pure change stream of
  `previews { directory, entries }` events (full list) on every change.
- `unsubscribePreviews { directory }`.
- `stopPreview { directory, name }`: the user's stop button. Same path as
  the tool.
- No "opened" event. An agent's request to show a server is the entry's
  `opened: { at, sessionID }` stamp. An event would be lost on every device
  that was not showing the session at that moment, the common case when the
  user switches sessions while the agent works. Each device keeps its own
  record of the stamps it has handled (per directory and name, the last
  `at`) and acts on newer ones when the user is in that session.
- `open`/`opened` is about the request, never about the user's tabs. The
  daemon does not know which tabs a device has, and the agent must not
  depend on them.

### Desktop

- Tabs opened from a preview are the user's tabs, in the user's partition
  (`persist:thinkite-browser`). The agent's own pages, later
  (thinkite/thinkite#31), live elsewhere and never in this panel.
- When the session on screen has an entry with an `opened` stamp newer than
  this device handled, and the entry is running with a primary port:
  - a tab of that session already on `localhost:<port>`: select it, no
    reload (HMR keeps it current);
  - otherwise add a tab at the URL. Never navigate a tab the user is on.
  - show the browser panel if it is closed: `open: true` is only for "let
    me see it" requests.
  - record the stamp as handled, whether or not a tab was made. A tab the
    user closes stays closed until the agent asks again.
- After that the tab is an ordinary tab: no following a port change, no
  closing on stop. A tab on the port of a stopped entry shows a strip:
  "web stopped" (no restart button in v1).
- The info panel gets a "Servers" card: a status dot, name, `:<port>`
  (opens it in a tab), status, stop. Stopped entries stay listed.
- No tunnel: the pages are on this Mac.

### Phone

- Preview screen per session: the list from `getPreviews` plus
  `subscribePreviews`, and a
  WebView on `http://localhost:<primaryPort>` of the selected entry. It has
  no JS bridge to the app: no `onMessage`, no injected scripts.
- While the screen is in the foreground, keep a `forwardTcp` listener for
  every running entry's ports, plus manual ones. Use the app's shared iroh
  endpoint and the `thinkite/tcp/1` ALPN with the 2-byte port header (both
  from the spike).
  - **Background:** close the listeners. **Foreground:** rebind them
    (verify on device).
  - **Taken port** (Metro's 8081 in dev builds, for example): show it on
    the chip; don't pick another number. The page's origin must stay
    `localhost:<same port>`.
- The session screen shows a "Preview · web :5180" banner when the session
  has running previews. It is built from the registry, not the transcript:
  in Code Mode the tool call sits inside an `execute` row.
- A newer `opened` stamp for the session on screen (same per-device record
  as the desktop): show the banner's open action. Don't navigate on the
  user's behalf.
- The selected entry stopped: show it as stopped; don't switch to another.

## Landing the spike

The `forward-tcp-spike` branch is local and unpushed. Take from it:

- **daemon:** `iroh-tcp-tunnel.ts` and its tests; the `thinkite/tcp/1` ALPN
  in `iroh-peer-server.ts`; the `iroh-duplex.ts` changes.
- **protocol:** `IROH_TCP_ALPN`, `IROH_TCP_HEADER_BYTES`.
- **app:** the shared-endpoint change in `iroh-wire.ts`. `dev/tunnel.tsx`
  is reference only.

Leave behind the react-native-webview 16 upgrade, its `proxy` prop patch and
`dev/proxy.tsx`. On iOS 27 the proxy approach cannot keep the `localhost`
origin. `main` has no react-native-webview at all, so adding it is a
decision of its own. 14.0.1 is `latest`; 16.0.0 is on the `next` tag.

## Security

- `preview_start` runs an arbitrary shell command through `/api/shell`, not
  through the agent's `shell` tool. opencode's permission check applies to
  the action `thinkite_preview_start`, so a user who must approve every
  shell command needs that action set to ask too. To verify: the default
  permission of a client MCP tool, and how the approval card shows the
  command.
- The TCP tunnel reaches any port on the Mac's loopback, behind the same
  known_clients gate that lets a paired phone drive the agent. That is no
  wider than what the phone can already do.
- The phone's WebView loads pages the agent wrote, so it gets no bridge
  into the app.

## Verification

- **vitest (daemon):** the registry against a fake shell client. Cover
  idempotent start (same command, different command, exited), rebuild from
  metadata, `shell.exited` handling, session filtering, and the 120
  character first lines (a test fails if one grows).
- **Gated e2e** (`THINKITE_E2E_PROVIDERS=1` style, isolated `opencode
  serve` with `HOME` and the XDG dirs in a temp dir): start, list, stop
  against real shells, and a daemon restart in the middle.
- **Model rerun:** the four 10-24 prompts against the real host, and
  repeat the attach-before-first-turn check.
- **Device:**
  - a page on 5180 calling an API on 8080, with HMR, over the tunnel;
  - background/foreground rebinding;
  - Metro's port taken in a dev build.

## Open questions

- Should the first line of `preview_start` name `open`? In the 10-25
  rerun against the real host, the "let me see it" prompt started the
  page without `open` (both stub runs had set it). One sample. Watch it
  before adding words.
- Do phone listeners need to cover ports of other projects? Not in v1: the
  preview screen covers the session's project only.
