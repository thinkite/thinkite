# Preview tool v1 — servers the agent starts, opened from desktop and phone

The agent starts dev servers and APIs through the daemon's `server_*`
tools and shows a page to the user with `preview_open`. The daemon creates
each server's shell, hands the agent its output, and keeps a registry of
the servers; the agent reads the URL from the output and decides when the
server is ready. The desktop opens shown pages in its browser panel, and
the phone reaches the servers through the iroh TCP tunnel from the
`forward-tcp-spike` branch. Letting the agent look at pages itself
(screenshots, snapshots, clicks) is a separate, later piece:
thinkite/thinkite#31.

## Goal

- Agent-side: `thinkite_server_start`, `_server_logs`, `_server_list`,
  `_server_stop` and `_preview_open`, served by the daemon over opencode's
  client MCP. Every long-running server the agent starts, page or API, goes
  through `server_start`.
- The daemon's registry is the one list of servers per project. Desktop and
  phone subscribe to it.
- Desktop: a page shown with `preview_open` opens as a tab in the session's
  browser panel. The info panel lists the project's servers, with a stop
  button for each.
- Phone: a preview screen for the session's project. While it is visible,
  every running server's ports are forwarded, so a page can call its API on
  another port (the case in the 10-24 test, where the page fetched
  `localhost:8080`). The screen has a server switcher and manual port
  entry.

## Non-goals

- No browser tools for the agent (thinkite/thinkite#31).
- No waiting for readiness and no choosing a port. `server_start` returns
  the first output; the agent reads the URL there (or in `server_logs`) and
  passes it to `preview_open`, which checks one fact and answers at once.
- No automatic discovery of servers the agent or the user started some other
  way (nohup, the shell tool's background mode, the user's own terminal).
  Manual port entry on the phone covers those.
- No multi-tab phone browser. One page at a time, with a switcher.
- No `PORT` injection or port reassignment (Claude Desktop's `autoPort`
  rewrites flags and inspects scripts). When a port is taken the server
  prints where it went, and the agent passes that URL.
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
    the job's result lookup fails once the shell is gone). That woke the
    idle session; the agent decided the harness had lost the server and
    restarted it with `nohup … & disown`, outside any shell.
- **10-25, this design.** The daemon owns the shells again (no session
  job, so stopping one wakes no agent, and every server is registered), but
  the agent judges readiness and the URL from the output, as in the
  agent-owned design. Detection, the grace period, the port rule and the
  `port` parameter stay gone. Checked on `opencode-go/deepseek-v4.1-flash`
  with the tools named `server_*` + `preview_open` and, as a control, all
  `preview_*`: 5/5 runs each went through the start tool, never shell
  background (the API-only prompt 3/3 each, never shown); the page and
  web+API prompts showed the page once it was up; a wrong `cwd` came back
  as "exited right away" with the output and the agent fixed it. The names
  made no difference here; `server_*` stays for what it says. Removing a
  daemon-created shell from outside left the session untouched for 30 s,
  and nothing came back on the port. With the tools there, the shell kept
  its jobs: across those 10 runs every look-around (`ls`, `cat`, `curl`)
  was a foreground shell call, and 5 more runs ("build the web app for
  production", "reinstall the web dependencies", "run the tests in api/",
  the test taking 3 s) ran `bun run build`, `bun install` and `bun test`
  in the foreground shell, never `server_start`. One build run checked
  `dist/` with a `python3 -m http.server` it started and killed inside a
  single shell command, which is the shell's job too.

What the experiment settled still holds:

| Finding | Consequence |
|---|---|
| `open: true` only for "let me see" prompts; false for checks and APIs | Showing is its own tool, `preview_open` |
| A second start of the same name with `open: true` restarted the server and hit "port in use" | Start is idempotent per name (below) |
| The stub's list showed servers from earlier sessions that were already dead | List checks liveness and filters by session |
| Restarting the stub lost its in-memory registry while the servers kept running | The registry persists (below) |
| `instructions` in the MCP initialize reply never reached the model | Tool descriptions are the only channel |
| Code Mode shows only the first line of each description, cut at 120 characters | Each first line has to stand on its own (below) |
| Each attach/detach injects a ~8.6–8.9k character "catalog changed" notice (anomalyco/opencode#55529) | One persistent connection per directory |
| Tools attached to `proj/web` are invisible to a session at `proj` | Attach to every session's exact directory |
| In Code Mode the call is nested in an `execute` tool row | Clients learn about previews from the registry, not from transcript rows |

## Architecture

```
opencode service ──client MCP (WS, per directory)── daemon: PreviewHost
      │  POST/GET/DELETE /api/shell, shell.exited events       │
      │                                                        ├─ Registry (per directory,
      │                                                        │   $THINKITE_HOME/previews.json)
      ▼                                                        ├─ router: subscribePreviews, stopPreview
  dev servers (shells the daemon created)                      ▼
      ▲                                          desktop (in process) / phone (iroh RPC)
      └── thinkite/tcp/1 (IrohTcpTunnel) ◄── phone forwardTcp listeners
```

`PreviewHost` lives in `packages/daemon`, not the desktop, so the tools
work under `thinkite up` too.

```
packages/daemon/src/preview/
  host.ts       connection per directory, events, re-checks
  registry.ts   entries, start/logs/open/stop, the URL check, persistence
  ports.ts      process tree → listening ports (ps + lsof -a -p)
  shells.ts     the slice of /api/shell used (create, get, tail, remove)
  tools.ts      names, descriptions, input schemas
```

## Tools

Tools are named `thinkite_<tool>` (the client name is `thinkite`). In Code
Mode the model calls them as `tools.thinkite.server_start(…)`. Every call
carries `_meta["ai.opencode/sessionID"]`.

Two groups: `server_*` run servers, pages and APIs alike; `preview_open`
shows a page to the user. "Server", not "service": service already means
launchd, systemd and `brew services` to the model, and opencode's own
managed service to us. The first lines below are the whole guidance the
model sees in the catalog, so the first lines of `server_start` and
`preview_open` each name the other. Lengths are measured and must stay
under 120 characters.

| Tool | First line of the description | Length |
|---|---|---|
| `server_start` | Run a dev server or API in the background (not shell background/nohup); to show a page, then call preview_open. | 111 |
| `server_logs` | Show a server_start server's recent output: whether it is ready, and the URL it serves. | 87 |
| `preview_open` | Show the user a page served by a server_start server, once its output says the URL it serves. | 93 |
| `server_list` | List servers started with server_start: status, and the URL if preview_open showed it. | 86 |
| `server_stop` | Stop a server started with server_start and free its port. | 58 |

`server_start` continues: "Use for any long-running process the user or
a page reaches over the network: web dev servers, API servers, websocket
servers, tunnels. Servers started with the shell tool's background mode or
nohup are invisible to the user and their phone. Returns the first output,
where servers usually print their URL; if it is not there yet, check
server_logs. The user sees every server in their Servers list;
preview_open puts a page in their browser. Starting a name that is already
running returns it instead of restarting it."

### `server_start({ name, command, cwd? })`

- `name` is the key, unique per directory. A server is a project resource, so
  a second session asking for the same name gets the running one.
- Idempotent:
  - **Same name, running, same command (or none):** no restart. Add the
    caller's session to the entry's `sessions` and return the recent
    output.
  - **Same name, running, different command:** an error result: "`web` is
    already running `<command>`; stop it first to change it." Never kill a
    server implicitly.
  - **Same name, ended, or new:** create a new shell and replace the entry.
- `shell.create({ command, cwd, metadata: { thinkite: { server: name,
  session } } })` with `location.directory`, and no `timeout`. A shell
  created this way belongs to no session's jobs: nothing is posted to a
  session when it ends.
- Wait 2 s, re-checking the shell every 250 ms, then return
  `Started "web". Output so far:` and the last 40 lines (ANSI stripped). If
  the shell ends first, an error result with its status and output (a busy
  port usually shows up here).

### `server_logs({ name, lines? })`

- The server's state and `shell.output`, default 40 lines, at most 200.
  Works on ended entries (opencode keeps exited shells for a while).

### `preview_open({ name, url })`

- Shows the page: there is no "register without showing". Every server is
  already in the registry from `server_start`.
- The entry must be running. `url` must be http or https. Then, by host:
  - **This Mac** (`localhost`, `127.x`, `::1`, `*.localhost`, `0.0.0.0`, or
    one of its interface addresses, like Vite's `Network:` line): the
    server's process tree must listen on the URL's port (`ports.ts`, one
    check, about 40 ms). If not, an error result lists the ports it does
    listen on, or says it listens on none yet, and nothing changes.
  - **Anything else** (a cloudflared or ngrok tunnel, a public host):
    taken as given. Checking it would mean an HTTP request, and a tunnel
    may need auth.
  - A reverse proxy on this Mac (`https://app.localhost` through Caddy) is
    rejected, since the proxy, not the server, holds the port. The error's
    port list lets the agent pass `http://localhost:<port>` instead.
- Set the entry's URL, stamp `opened` with the caller's session (below),
  and add the session. Calling it again shows the page again.
- Result: `Sent http://localhost:5174/ to the user's browser.` The words
  must not claim more than the daemon knows: it sees the request, not the
  user's tabs.

### `server_list({ all? })`

- Default: entries whose `sessions` include the caller. `all: true` lists
  the whole directory. Either way, end with "N more in this project (pass
  all: true)" when some are hidden.
- Re-check each running entry with `shell.get` before answering. A line:
  `web: running, http://localhost:5173/ shown to the user — \`bun run
  dev\``; `api: running — \`bun api.ts\``; ended ones say `exited (code 1)`
  or `killed`.

### `server_stop({ name })`

- `shell.remove`, which kills the process tree. Wait (up to 3 s) until the
  tree no longer listens, then mark the entry `killed`. It stays, so clients
  can show it stopped; a later start of the name replaces it.
- Stopping an entry that already ended answers "not running (exited)".
- If the entry has other sessions, say so in the result: the server
  stopped for them too.
- Stop never touches the user's tabs (see Desktop), and wakes no agent.

## Registry

```ts
type Entry = {
  directory: string;
  name: string;
  shellID: string;
  pid?: number;
  command: string;
  cwd?: string;
  url?: string;               // set by preview_open
  localPort?: number;         // set when that URL is on this Mac (checked)
  opened?: { at: number; sessionID: string }; // latest request to show it
  sessions: string[];         // first one first
  status: "running" | "exited" | "killed" | "timeout";
  startedAt: number;
  exit?: number;
};
```

- **opencode's shells say whether a server runs; everything else lives
  here.** The URL and the request to show it come after the shell is
  created, and opencode has no API to change a shell's metadata.
- **Persistence:** every change writes `$THINKITE_HOME/previews.json`
  (atomic rename, mode 600). At start the daemon reads back the entries
  that were running; ones that had already ended are left behind, as an
  in-memory registry would lose them.
- **Liveness:** subscribe to the event bus. On `shell.exited` for a known
  shell, update the entry and push to clients. On attach and every
  reconnect, re-check the directory's running entries with `shell.get`
  (catches exits while the daemon was down), and so do `server_list` and
  the clients' snapshot.
- An opencode service restart ends every shell, so the re-check marks the
  entries ended and clients see them stop.

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

## The URL check (`ports.ts`)

- The shell's pid, its descendants from `ps -axo pid=,ppid=`, then
  `lsof -a -p <pids> -nP -iTCP -sTCP:LISTEN -Fn`. Each costs about 20 ms
  (measured 10-24).
- Scoped to the server's tree, so a port held by another project (Vite on
  5173 elsewhere, this one moved to 5174) does not pass for this server.
- No HTTP probe: a listening port is the fact the agent's URL depends on,
  and an HTTP request can make a dev server compile or upset a non-HTTP
  listener.

## Clients

### Protocol (`@thinkite/protocol` 0.2.3)

- Same shape as git status: `getPreviews { directory }` is the snapshot,
  `subscribePreviews { directory }` a pure change stream of
  `previews { directory, entries }` events (full list) on every change.
- `unsubscribePreviews { directory }`.
- `stopPreview { directory, name }`: the user's stop button. Same path as
  `server_stop`.
- An entry carries `name`, `url` (once shown), `status`, `opened`,
  `command`, `sessions`, `startedAt`, `exit`. No port list.
- No "opened" event. An agent's request to show a page is the entry's
  `opened: { at, sessionID }` stamp. An event would be lost on every device
  that was not showing the session at that moment, the common case when the
  user switches sessions while the agent works. Each device keeps its own
  record of the stamps it has handled (per directory and name, the last
  `at`) and acts on newer ones when the user is in that session.
- `opened` is about the request, never about the user's tabs. The daemon
  does not know which tabs a device has, and the agent must not depend on
  them.

### Desktop

- Tabs opened from a preview are the user's tabs, in the user's partition
  (`persist:thinkite-browser`). The agent's own pages, later
  (thinkite/thinkite#31), live elsewhere and never in this panel.
- When the session on screen has a running entry with a URL and an
  `opened` stamp newer than this device handled:
  - a tab of that session already on the same origin: select it, no reload
    (HMR keeps it current);
  - otherwise add a tab at the URL, or reuse the active tab if it is
    blank. Never navigate a tab the user is on.
  - show the browser panel if it is closed.
  - record the stamp as handled, whether or not a tab was made. A tab the
    user closes stays closed until the agent asks again.
- After that the tab is an ordinary tab: no following a URL change, no
  closing on stop. A tab on the origin of a stopped entry (localhost and
  127.0.0.1 count as one host) shows a strip: "web stopped" (no restart
  button in v1).
- The info panel gets a "Servers" card: a status dot, name, `:<port>` for a
  shown page on this Mac or the host for a tunnel (opens it in a tab),
  status, stop. Servers never shown (APIs) have no link. Stopped entries
  stay listed.
- No tunnel: local pages are on this Mac.

### Phone

- Preview screen per session: the list from `getPreviews` plus
  `subscribePreviews`, and a WebView on the selected entry's URL. It has
  no JS bridge to the app: no `onMessage`, no injected scripts.
- While the screen is in the foreground, keep a `forwardTcp` listener for
  every port of every running server (the daemon reads them from the
  servers' process trees; a frame for that comes with the phone work),
  plus manual ones. Use the app's shared iroh endpoint and the
  `thinkite/tcp/1` ALPN with the 2-byte port header (both from the spike).
  - A URL on this Mac loads as `localhost:<same port>` through the
    listener. A tunnel or public URL loads directly, with no listener.
  - **Background:** close the listeners. **Foreground:** rebind them
    (verify on device).
  - **Taken port** (Metro's 8081 in dev builds, for example): show it on
    the chip; don't pick another number. The page's origin must stay
    `localhost:<same port>`.
- The session screen shows a "Preview · web :5180" banner when the session
  has a shown page. It is built from the registry, not the transcript: in
  Code Mode the tool call sits inside an `execute` row.
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

- `server_start` runs an arbitrary shell command through `/api/shell`, not
  through the agent's `shell` tool. opencode's permission check applies to
  the action `thinkite_server_start`, so a user who must approve every
  shell command needs that action set to ask too. To verify: the default
  permission of a client MCP tool, and how the approval card shows the
  command.
- An agent can put any http(s) URL in the user's browser through
  `preview_open`. That is no more than a link in its reply, opened for the
  user; the tab is in the user's partition, as any page they open.
- The TCP tunnel reaches any port on the Mac's loopback, behind the same
  known_clients gate that lets a paired phone drive the agent. That is no
  wider than what the phone can already do.
- The phone's WebView loads pages the agent wrote, so it gets no bridge
  into the app.

## Verification

- **vitest (daemon):** the registry against a fake shell client. Covered:
  start (output, idempotency, a different command, a server that ends at
  once), logs, the local URL check (served, moved port, not listening
  yet), tunnel URLs, showing again, session filtering, stop, a name
  restarted after it ended, `shell.exited`, persistence across a restart
  with an exit in between, and the 120 character first lines.
- **Gated e2e** (`THINKITE_E2E_PROVIDERS=1` style, isolated `opencode
  serve` with `HOME` and the XDG dirs in a temp dir): start, logs, open,
  stop against real shells, and a daemon restart in the middle.
- **Model rerun:** the 10-24 prompts against the real host. Check that the
  agent uses `server_start` rather than shell background (the API-only
  prompt above all), shows pages with `preview_open` and not APIs, and
  that stopping a server from outside does not make it start the server
  again.
- **Device:**
  - a page on 5180 calling an API on 8080, with HMR, over the tunnel;
  - background/foreground rebinding;
  - Metro's port taken in a dev build.

## Open questions

- Do phone listeners need to cover ports of other projects? Not in v1: the
  preview screen covers the session's project only.
