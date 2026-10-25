# Preview tool v1 — servers the agent starts, opened from desktop and phone

The agent starts dev servers and APIs through the daemon's `server_*`
tools. The daemon creates each server's shell, hands the agent its output,
looks up the ports the server listens on, and keeps a registry of the
servers; its URL is `http://localhost:<lowest port>/`. To show the user a
page, the agent writes the link in its reply. The client the user reads it
in opens it by its port: the desktop in the session's browser panel, the
phone through the iroh TCP tunnel from the `forward-tcp-spike` branch.
No tool opens or touches the user's tabs: one opencode server has many
clients, each with its own tabs, and neither opencode nor the daemon knows
which one the user is looking at. A browser for the agent itself (off
screen: screenshots, snapshots, clicks) is the later piece:
thinkite/thinkite#31.

## Goal

- Agent-side: `thinkite_server_start`, `_server_logs`, `_server_list` and
  `_server_stop`, served by the daemon over opencode's client MCP. Every
  long-running server the agent starts, page or API, goes through
  `server_start`.
- The daemon's registry is the one list of servers per project. Desktop
  and phone subscribe to it.
- Desktop: a link in a reply to one of the project's running servers (by
  port) opens in the session's browser panel; any other link opens in the
  user's browser. The info panel lists the project's servers, with why
  each one stopped and a stop button for the running ones.
- Phone: while the app is in the foreground, every port of every running
  server is forwarded, so a page can call its API on another port (the case
  in the 10-24 test, where the page fetched `localhost:8080`) and a
  `localhost` link anywhere in the app opens.

## Non-goals

- No tool that opens, reads or acts on the user's tabs, now or later. Tabs
  belong to a client, and the agent cannot address a client: a request
  sent to "the user's browser" lands on whichever device acts on it first,
  or none (the TUI, OpenCode's own app). See "Removed: browser_open".
- No browser automation for the agent yet (thinkite/thinkite#31). When it
  comes, its tabs are the agent's, per session, off screen.
- No waiting for readiness. `server_start` returns the first output and the
  URL once the server listens; the agent reads the rest in `server_logs`.
- No automatic discovery of servers the agent or the user started some other
  way (nohup, the shell tool's background mode, the user's own terminal).
  Manual port entry on the phone covers those.
- No multi-tab phone browser. One page at a time, with a switcher.
- No `PORT` injection or port reassignment (Claude Desktop's `autoPort`
  rewrites flags and inspects scripts). When a port is taken the server
  moves or fails, and the lookup finds where it went.
- No pushing anything into agent sessions. A stop is recorded on the
  server and reaches an agent through the next tool result that touches it.
- The desktop/phone UI does not start servers.
- No launch configuration file. If the UI ever gets a "start web" button,
  that needs Thinkite's own file (for example `.thinkite/launch.json`),
  not Claude Code's `.claude/launch.json`. t3code's `t3.json` scripts
  (`previewUrl`, `autoOpenPreview`) are the reference.

## History

- **10-24 experiment.** Stub tools served over client MCP, opencode 2.1.4
  isolated serve, DeepSeek V4.1 Flash Free, Vite web / Bun API / Next.js
  test projects, 4 prompts × 2 arms plus lifecycle runs. The stub's
  `preview_start` ran the command itself; 9/9 long-running servers went
  through it, backends included.
- **10-25, first build.** `preview_start({ name, command, open, port })`:
  the daemon polled `ps` + `lsof` for up to 30 s (2 more minutes in the
  background), waited 2 s for the expected port and fell back to the
  nearest listening one.
- **10-25, agent-owned shells** (fceb01f). The agent started servers with
  its shell tool's background mode and registered them with
  `preview_open({ name, shellID, url, open })`. Two findings against it, on
  `opencode-go/deepseek-v4.1-flash`:
  - Asked to run only the API, the agent started it in the background,
    checked it with curl, and never registered it.
  - Removing a shell-tool background shell (the stop button's path) makes
    opencode post `<shell id=… state="error">Shell.NotFoundError</shell>`
    into the session that started it (the shell tool's `notifyWhenDone`:
    the job's result lookup fails once the shell is gone;
    anomalyco/opencode#57977, reproduced, open). That woke the idle
    session; the agent decided the harness had lost the server and
    restarted it with `nohup … & disown`, outside any shell.
- **10-25, daemon-owned shells** (7311682). The daemon owns the shells
  again (no session job, so stopping one wakes no agent, and every server
  is registered), but the agent judges readiness and the URL from the
  output. Checked on `opencode-go/deepseek-v4.1-flash` with the tools
  named `server_*` + `preview_open` and, as a control, all `preview_*`:
  5/5 runs each went through the start tool, never shell background (the
  API-only prompt 3/3 each, never shown); a wrong `cwd` came back as
  "exited right away" with the output and the agent fixed it. The names
  made no difference here; `server_*` stays for what it says. Removing a
  daemon-created shell from outside left the session untouched for 30 s.
  The shell kept its jobs: every look-around (`ls`, `cat`, `curl`) was a
  foreground shell call, and build, install and test prompts (5 runs, the
  test taking 3 s) ran `bun run build`, `bun install` and `bun test` in
  the foreground shell, never `server_start`.
- **10-25, this design.** `preview_open({ name, url })` becomes
  `browser_open({ url })`, the first browser tool; open requests move off
  the servers into their own list. Servers stay per project, record who
  started and who or what stopped them, and the phone gets one global list
  of ports to forward while the app is in the foreground. Smoke on
  `opencode-go/deepseek-v4.1-flash`: the web+API prompt ran two
  `server_start`s, checked the API with `fetch`, then `browser_open`ed the
  page; the forward-port list was pushed after each start. After a user
  stop, "the page doesn't load anymore" in the same session: the agent's
  `server_list` read "web: was stopped by the user just now", it started
  web again (the result carried the same note) and reopened the page.
- **10-25, links instead of `browser_open`.** Removed: see below. The
  entry's URL comes from the ports the daemon looks up, not from the
  agent; `server_start` tells the agent to write the URL in its reply.

### Removed: `browser_open`

`browser_open({ url })` recorded an open request per session and origin;
each device kept its own record of the requests it had acted on and opened
newer ones when the user came to that session. It had to, because the
daemon cannot know which client the user is on: one opencode server serves
Thinkite on the Mac, the phone, the TUI and OpenCode's own app, each with
its own tabs. So the result ("Sent … to the user's browser") promised more
than the daemon knew: the desktop opened the page only once the user came
to the session, the phone would have opened it whenever the app next came
up, and the other clients never did. Tools that act on a user's tab later
(read it, click) would need to name a client's tab, which nothing on the
server side can. opencode's `experimental.browser`, which lends one
client's embedded browser to every client of the session, runs into the
same thing.

A link in the reply has none of this: it stays in the transcript, every
client shows it, and the user's tap is the intent. The cost is that the
agent can no longer bring a page up by itself.

What the experiment settled still holds:

| Finding | Consequence |
|---|---|
| `open: true` only for "let me see" prompts; false for checks and APIs | Opening is the user's: a link in the reply |
| A second start of the same name with `open: true` restarted the server and hit "port in use" | Start is idempotent per name (below) |
| The stub's list showed servers from earlier sessions that were already dead | List checks liveness |
| Restarting the stub lost its in-memory registry while the servers kept running | The registry persists (below) |
| `instructions` in the MCP initialize reply never reached the model | Tool descriptions are the only channel |
| Code Mode shows only the first line of each description, cut at 120 characters | Each first line has to stand on its own (below) |
| Each attach/detach injects a ~8.6–8.9k character "catalog changed" notice (anomalyco/opencode#55529) | One persistent connection per directory |
| Tools attached to `proj/web` are invisible to a session at `proj` | Attach to every session's exact directory |
| In Code Mode the call is nested in an `execute` tool row | Clients learn about servers and pages from the registry, not from transcript rows |

## Architecture

```
opencode service ──client MCP (WS, per directory)── daemon: PreviewHost
      │  POST/GET/DELETE /api/shell, shell.exited events       │
      │                                                        ├─ Registry: servers and their ports per
      │                                                        │   directory, ports to forward (global),
      │                                                        │   $THINKITE_HOME/previews.json
      ▼                                                        ├─ router: subscribePreviews, stopPreview,
  dev servers (shells the daemon created)                      │   subscribeForwardPorts
      ▲                                                        ▼
      │                                          desktop (in process) / phone (iroh RPC)
      └── thinkite/tcp/1 (IrohTcpTunnel) ◄── phone forwardTcp listeners
```

`PreviewHost` lives in `packages/daemon`, not the desktop, so the tools
work under `thinkite up` too.

```
packages/daemon/src/preview/
  host.ts       connection per directory, events, re-checks
  registry.ts   servers, their ports, ports to forward, persistence
  ports.ts      process tree → listening ports (ps + lsof -a -p)
  shells.ts     the slice of /api/shell used (create, get, tail, remove)
  tools.ts      names, descriptions, input schemas
```

## Tools

Tools are named `thinkite_<tool>` (the client name is `thinkite`). In Code
Mode the model calls them as `tools.thinkite.server_start(…)`. Every call
carries `_meta["ai.opencode/sessionID"]`. The model is never shown session
IDs (opencode's prompt does not carry its own either); where it matters,
the daemon compares them and writes "yours" or "another session".

`server_*` run servers, pages and APIs alike. "Server", not "service":
service already means launchd, systemd and `brew services` to the model,
and opencode's own managed service to us. The first lines below are the
whole guidance the model sees in the catalog, so `server_start`'s says how
to show a page: write its URL in the reply. Its body adds that `open` on a
URL only reaches this Mac's default browser. Lengths are measured and must
stay under 120 characters.

| Tool | First line of the description | Length |
|---|---|---|
| `server_start` | Run a dev server or API in the background (not shell background/nohup); to show a page, write its URL in your reply. | 116 |
| `server_logs` | Show a server_start server's recent output: whether it is ready, and the URL it serves. | 87 |
| `server_list` | List this project's servers: status, URL, which are yours, and why one stopped. | 79 |
| `server_stop` | Stop a server started with server_start and free its port. | 58 |

### `server_start({ name, command, cwd? })`

- `name` is the key, unique per project directory. A server is a project
  resource: any session sees it, and a second session asking for the same
  name gets the running one.
- Idempotent:
  - **Same name, running, same command (or none):** no restart; return the
    recent output.
  - **Same name, running, different command:** an error result: "`web` is
    already running `<command>`; stop it first to change it." Never kill a
    server implicitly.
  - **Same name, ended, or new:** create a new shell and replace the entry.
    This is how a server is restarted. Before replacing, read how the old
    one ended and append it to the result ("Note: the previous `web` was
    stopped by the user 3 min ago."): the start goes ahead, and the agent
    knows to mention it.
- `shell.create({ command, cwd, metadata: { thinkite: { server: name,
  session } } })` with `location.directory`, and no `timeout`. A shell
  created this way belongs to no session's jobs: nothing is posted to a
  session when it ends.
- Wait 2 s, re-checking the shell every 250 ms, look up its ports, then
  return `Started "web", listening on http://localhost:5173/. Output so
  far:` and the last 40 lines (ANSI stripped); without "listening on" when
  it does not listen yet. If the shell ends first, an error result with how
  it ended and its output (a busy port usually shows up here).
- Then look up its ports again at 1, 3, 10 and 30 s; push the entry and
  the forward-port list when they change.

### `server_logs({ name, lines? })`

- How the server stands (with its URL while it runs) and `shell.output`,
  default 40 lines, at most 200. Looks up ports first, so a server that
  started listening after the start shows its URL here. Works on ended
  entries (opencode keeps exited shells for a while).

### `server_list()`

- Every server of the project, re-checked with `shell.get`. A line per
  server: `web: is running, http://localhost:5173/ — \`bun run dev\`
  (yours)`, `docs: was stopped by the user 3 min ago — \`bun run docs\``.
- "(yours)": started by the caller's session.

### `server_stop({ name })`

- Any session may stop any of the project's servers. If another session
  started it, the result says so: "Another session started it; it stopped
  there too."
- `shell.remove`, which kills the process tree. Wait (up to 3 s) until the
  tree no longer listens, then mark the entry ended by this agent. It
  stays, so clients and later tool results can say how it ended; a later
  start of the name replaces it.
- Stopping an entry that already ended answers how it ended.
- Stop never touches the user's tabs (see Desktop), and wakes no agent.

### Why a server ended

Recorded on the entry as `ended: { at, by, sessionID?, exit? }`:

| `by` | When | What an agent reads |
|---|---|---|
| `user` | The desktop's or phone's stop button | was stopped by the user |
| `agent` | `server_stop`, with the caller's session | was stopped by you / by another session |
| `process` | The process exited on its own | exited (code 1) |
| `external` | The shell ended some other way: opencode's kill, a service restart | was killed outside Thinkite |

While `server_stop` or the stop button removes a shell, the registry
remembers who is stopping it, so the `shell.exited` event that opencode
publishes during the removal is attributed to them, not to "external".

Agents rarely call `server_list` before acting (once in 15 runs), so the
reason goes where they will meet it: `server_start` on that name,
`server_logs`, `server_list`, `server_stop`.

## Registry

```ts
type Entry = {
  directory: string;
  name: string;               // unique per directory
  shellID: string;
  pid?: number;
  command: string;
  cwd?: string;
  ports?: number[];           // listening, ascending; last seen, kept after it ends
  status: "running" | "ended";
  started: { at: number; sessionID?: string };
  ended?: {
    at: number;
    by: "user" | "agent" | "process" | "external";
    sessionID?: string;
    exit?: number;
  };
};

```

The URL is derived, not stored: `http://localhost:<ports[0]>/`. The lowest
port is the page's in the common cases (Vite's old HMR port 24678, Node's
inspector 9229 and wrangler's 9229 all come after it); an agent that knows
better writes the right link in its reply anyway.

- **opencode's shells say whether a server runs; everything else lives
  here.** The ports, who started and stopped it come after the shell is
  created, and opencode has no API to change a shell's metadata.
- **Persistence:** every change writes `$THINKITE_HOME/previews.json`
  (`v: 2`, atomic rename, mode 600). At start the daemon reads back the
  servers that were running; servers that had already ended are left
  behind. Files from before carry a `requests` list and `url`/`localPort`
  on entries; they are ignored, and the next lookup fills `ports`.
- **Liveness:** subscribe to the event bus. On `shell.exited` for a known
  shell, end the entry and push to clients. On attach and every reconnect,
  re-check the directory's running entries with `shell.get` (catches exits
  while the daemon was down), and so do `server_list` and the clients'
  snapshot.
- An opencode service restart ends every shell, so the re-check marks the
  entries ended (`external`) and clients see them stop.

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
  10 s) and re-check the registry after each reconnect.
- Implement the WebSocket MCP server ourselves (about 100 lines, as in the
  stub). The `@opencode/client/mcp` helper would also work, but we need the
  connection events for the re-check, and we don't send `instructions`.
- Attaching before a session's first turn avoids the notice: verified
  10-25. The host attached on `session.created` about 1 ms after the
  event, and the first turn had the tools with no "catalog changed"
  message.
- Protocol version: speak 2025-11-25 only. opencode supports 2026-07-28
  since anomalyco/opencode#48937, but pins attached connections to the
  legacy handshake (`packages/core/src/mcp/client.ts`: `config.type ===
  "attached" ? "legacy"`). Follow `connectClientMcp` if that changes.

## Ports (`ports.ts`)

- A server's pid, its descendants from `ps -axo pid=,ppid=`, then
  `lsof -a -p <pids> -nP -iTCP -sTCP:LISTEN -Fn`. Each costs about 20 ms
  (measured 10-24).
- Scoped to the server's tree, so a port held by another project (Vite on
  5173 elsewhere, this one moved to 5174) does not pass for this server.
- No HTTP probe: an HTTP request can make a dev server compile (Next.js
  takes seconds on the first one) or upset a non-HTTP listener.
- One lookup feeds both: each running entry's `ports` (only replaced by a
  non-empty, different list) and the forward-port list (every running
  server of every project). Run 2 s into a start and at 1, 3, 10 and 30 s
  after it, after a stop or exit, in `server_logs` and `server_list`, and
  on request.

## Clients

### Protocol (`@thinkite/protocol` 0.2.5)

- Per project, same shape as git status: `getPreviews { directory }` is the
  snapshot `{ entries }`, `subscribePreviews { directory }` a pure change
  stream of `previews { directory, entries }` on every change.
  `unsubscribePreviews { directory }`.
- An entry carries `ports` and `url` once its server listens. 0.2.5 drops
  0.2.4's `requests` and `localPort`.
- `stopPreview { directory, name }`: the user's stop button, recorded as
  `by: "user"`.
- Global, for the phone: `getForwardPorts` is the snapshot,
  `subscribeForwardPorts` a pure change stream of `forwardPorts { ports }`,
  each `{ port, directory, name }`. `unsubscribeForwardPorts`.

### Desktop

- Links in messages: bare URLs are linked too (`autolink="gfm"`), since
  agents write `http://localhost:5173/` as often as a markdown link. A link
  to `localhost`, `127.x`, `[::1]` or `*.localhost` on a port of one of the
  project's running servers opens in the session's browser panel
  (`serverForLink`): a tab already on that origin is selected, otherwise a
  new tab or the blank active one, and the panel comes up. Any other link
  opens in the user's browser.
- Those tabs are the user's, in the user's partition
  (`persist:thinkite-browser`). The agent's own pages, later
  (thinkite/thinkite#31), live elsewhere and never in this panel.
- After that the tab is an ordinary tab: no following a URL change, no
  closing on stop. A tab on a port of a stopped server shows a strip:
  "web stopped" (no restart button in v1).
- The info panel's "Servers" card: a status dot, name, `:<port>` of its
  URL while it runs (opens it in a tab), state (Running, Stopped, Stopped
  by agent, Exited (n), Killed), stop. A server that does not listen yet
  has no link. Stopped entries stay listed.
- No tunnel: local pages are on this Mac.

### Phone

- **Forwarding, app-wide:** while the app is in the foreground, keep a
  `forwardTcp` listener for every port in the forward-port list, plus
  manual ones; close them all on background and listen again on active
  (the spike's rule, with the app's one shared iroh endpoint). The
  `thinkite/tcp/1` ALPN with the 2-byte port header (both from the spike).
  - Scope: the running servers' ports, not every port the Mac listens on.
    A Mac has dozens (databases, Docker, IDEs), some would collide with the
    phone's own (Metro's 8081 in dev builds), and iOS loopback is shared
    by all apps.
  - **Taken port:** show it; don't pick another number. The page's origin
    must stay `localhost:<same port>`.
- **Links in messages, now** (`lib/open-link.ts`): a link to the Mac
  itself (`localhost`, `127.x`, `[::1]`, `*.localhost`) is told apart by
  its port against `getForwardPorts`. Until forwarding lands it opens an
  alert: the server that serves it on the Mac, or that none does. Any
  other http(s) link opens in the in-app browser (`expo-web-browser`).
- **With forwarding:** a `localhost` link on a forwarded port loads as
  `http://localhost:<port>` plus its path, through the listener. Anything
  else (a tunnel, a public site) loads directly.
- Preview screen: the project's servers from `getPreviews` plus
  `subscribePreviews`, and a WebView on the selected page. No JS bridge to
  the app: no `onMessage`, no injected scripts. The screen's design
  (server list, banner, manual entry) is still open.
- The selected page's server stopped: show it as stopped and why; don't
  switch to another.

## Later: the agent's browser

The agent gets a browser of its own (thinkite/thinkite#31): tabs held by
the daemon, per session, rendered off screen for the agent's own checks
(screenshots, snapshots, console, clicks). The user may watch, read only.
It never touches the user's tabs, and the `browser_*` names are kept for
it.

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

- `server_start` runs an arbitrary shell command through `/api/shell`, not
  through the agent's `shell` tool. opencode's permission check applies to
  the action `thinkite_server_start`, so a user who must approve every
  shell command needs that action set to ask too. To verify: the default
  permission of a client MCP tool, and how the approval card shows the
  command.
- A page opens only when the user taps its link. On the desktop, a link
  to one of the project's servers opens in the user's partition, as any
  page they open.
- The TCP tunnel reaches any port on the Mac's loopback, behind the same
  known_clients gate that lets a paired phone drive the agent. That is no
  wider than what the phone can already do. The phone only listens on the
  running servers' ports.
- The phone's WebView loads pages the agent wrote, so it gets no bridge
  into the app.

## Verification

- **vitest (daemon):** the registry against a fake shell client. Covered:
  start (output, idempotency across sessions, a different command, a
  server that ends at once, a restart that says how the last one ended),
  logs, ports and URL (the lowest port, a port that opens after the start,
  the ports of an ended server), the project-wide list with "(yours)", stop reasons
  (user, agent, the exit event arriving first, process exit, an outside
  kill), the forward-port list across projects, persistence across a
  restart with an exit in between, the router frames, and the 120
  character first lines. Desktop and phone: which links count as a
  server's page (`serverForLink`, `localPort`, `macPageNotice`).
- **Gated e2e** (`THINKITE_E2E_PROVIDERS=1` style, isolated `opencode
  serve` with `HOME` and the XDG dirs in a temp dir): start, logs, stop
  against real shells, and a daemon restart in the middle.
- **Model rerun:** the 10-24 prompts against the real host. Check that the
  agent uses `server_start` rather than shell background, writes the page's
  link in its reply (and not an API's, nor `open`), and that stopping a
  server from outside does not make it start the server again.
- **Device:** a dev page that lists the forward ports and opens pages:
  - a page on 5180 calling an API on 8080, with HMR, over the tunnel;
  - opening and closing all listeners in a loop, timed, on Wi-Fi and 5G;
  - background/foreground and lock cycles;
  - Metro's port taken in a dev build;
  - the relay path (never hit in the spike).

## Open questions

- Do phone listeners need to cover ports of other paired Macs? Not in v1:
  one daemon at a time.
- When a session is archived or deleted, should its servers stop? Not in
  v1: servers are the project's, and the user stops them from the Servers
  card.
