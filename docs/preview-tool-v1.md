# Preview tool v1 — servers the agent starts, opened from desktop and phone

The agent starts dev servers and APIs through the daemon's `server_*`
tools and opens pages in the user's browser with `browser_open`. The daemon
creates each server's shell, hands the agent its output, and keeps a
registry of the servers and of the open requests; the agent reads the URL
from the output and decides when the server is ready. The desktop opens
the requested pages in its browser panel, and the phone reaches the
servers through the iroh TCP tunnel from the `forward-tcp-spike` branch.
`browser_open` is the first of the browser tools; letting the agent look at
pages itself (screenshots, snapshots, clicks) is the later piece:
thinkite/thinkite#31.

## Goal

- Agent-side: `thinkite_server_start`, `_server_logs`, `_server_list`,
  `_server_stop` and `_browser_open`, served by the daemon over opencode's
  client MCP. Every long-running server the agent starts, page or API, goes
  through `server_start`.
- The daemon's registry is the one list of servers and open requests per
  project. Desktop and phone subscribe to it.
- Desktop: a page the agent opens with `browser_open` becomes a tab in the
  session's browser panel. The info panel lists the project's servers, with
  why each one stopped and a stop button for the running ones.
- Phone: while the app is in the foreground, every port of every running
  server is forwarded, so a page can call its API on another port (the case
  in the 10-24 test, where the page fetched `localhost:8080`) and a
  `localhost` link anywhere in the app opens. A preview screen per session
  shows its pages.

## Non-goals

- No browser automation for the agent yet (thinkite/thinkite#31).
- No agent-owned tabs yet. `browser_open` only opens the user's tabs; see
  "Later: tab owners".
- No waiting for readiness and no choosing a port. `server_start` returns
  the first output; the agent reads the URL there (or in `server_logs`) and
  passes it to `browser_open`, which checks one fact and answers at once.
- No automatic discovery of servers the agent or the user started some other
  way (nohup, the shell tool's background mode, the user's own terminal).
  Manual port entry on the phone covers those.
- No multi-tab phone browser. One page at a time, with a switcher.
- No `PORT` injection or port reassignment (Claude Desktop's `autoPort`
  rewrites flags and inspects scripts). When a port is taken the server
  prints where it went, and the agent passes that URL.
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

What the experiment settled still holds:

| Finding | Consequence |
|---|---|
| `open: true` only for "let me see" prompts; false for checks and APIs | Opening is its own tool, `browser_open` |
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
      │                                                        ├─ Registry: servers + open requests per
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
  registry.ts   servers, open requests, ports to forward, persistence
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

Two groups: `server_*` run servers, pages and APIs alike; `browser_open`
puts a page in the user's browser. "Server", not "service": service
already means launchd, systemd and `brew services` to the model, and
opencode's own managed service to us. The first lines below are the whole
guidance the model sees in the catalog, so the first lines of
`server_start` and `browser_open` each name the other. Lengths are
measured and must stay under 120 characters.

| Tool | First line of the description | Length |
|---|---|---|
| `server_start` | Run a dev server or API in the background (not shell background/nohup); to show a page, then call browser_open. | 111 |
| `server_logs` | Show a server_start server's recent output: whether it is ready, and the URL it serves. | 87 |
| `browser_open` | Open a page in the user's browser: a URL from a server_start server's output, or any http(s) page. | 98 |
| `server_list` | List this project's servers: status, URL if opened, which are yours, and why one stopped. | 89 |
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
- Wait 2 s, re-checking the shell every 250 ms, then return
  `Started "web". Output so far:` and the last 40 lines (ANSI stripped). If
  the shell ends first, an error result with how it ended and its output
  (a busy port usually shows up here).
- Then look for its ports at 1, 3, 10 and 30 s and push the forward-port
  list when it changes.

### `server_logs({ name, lines? })`

- How the server stands and `shell.output`, default 40 lines, at most 200.
  Works on ended entries (opencode keeps exited shells for a while).

### `browser_open({ url })`

- `url` must be http or https. By host:
  - **This Mac** (`localhost`, `127.x`, `::1`, `*.localhost`, `0.0.0.0`, or
    one of its interface addresses, like Vite's `Network:` line): one of
    the project's running servers must listen on the URL's port (its
    process tree, `ports.ts`; one check per running server, about 40 ms
    each). That server's entry gets the URL and `localPort`. If none
    listens, an error result: which server served that port and how it
    ended, or which ports the running servers do listen on. Nothing is
    opened.
  - **Anything else** (a cloudflared or ngrok tunnel, a public site, docs):
    taken as given. It is no more than a link in the agent's reply, opened
    for the user.
  - A reverse proxy on this Mac (`https://app.localhost` through Caddy) is
    rejected, since the proxy, not a server of ours, holds the port. The
    error's port list lets the agent pass `http://localhost:<port>`.
- Record an open request `{ url, sessionID, at, server? }`, the latest per
  session and origin (at most 100 per project, oldest dropped).
- Result: `Sent http://localhost:5174/ to the user's browser.` The words
  must not claim more than the daemon knows: it sees the request, not the
  user's tabs.

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
`browser_open` on its port, `server_logs`, `server_list`, `server_stop`.

## Registry

```ts
type Entry = {
  directory: string;
  name: string;               // unique per directory
  shellID: string;
  pid?: number;
  command: string;
  cwd?: string;
  url?: string;               // the page browser_open last opened from it
  localPort?: number;         // that URL's port (checked to be this server's)
  status: "running" | "ended";
  started: { at: number; sessionID?: string };
  ended?: {
    at: number;
    by: "user" | "agent" | "process" | "external";
    sessionID?: string;
    exit?: number;
  };
};

type BrowserRequest = {
  url: string;
  sessionID: string;
  at: number;
  server?: string;            // for a URL on this Mac
};
```

- **opencode's shells say whether a server runs; everything else lives
  here.** The URL, who started and stopped it, and the open requests come
  after the shell is created, and opencode has no API to change a shell's
  metadata.
- **Persistence:** every change writes `$THINKITE_HOME/previews.json`
  (`v: 2`, atomic rename, mode 600). At start the daemon reads back the
  servers that were running and all open requests; servers that had
  already ended are left behind.
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
- No HTTP probe: a listening port is the fact the agent's URL depends on,
  and an HTTP request can make a dev server compile or upset a non-HTTP
  listener.
- Used twice: `browser_open`'s check, and the forward-port list (every
  running server of every project, recomputed after a start at 1, 3, 10
  and 30 s, after a stop or exit, and on request).

## Clients

### Protocol (`@thinkite/protocol` 0.2.4)

- Per project, same shape as git status: `getPreviews { directory }` is the
  snapshot `{ entries, requests }`, `subscribePreviews { directory }` a
  pure change stream of `previews { directory, entries, requests }` on
  every change. `unsubscribePreviews { directory }`.
- `stopPreview { directory, name }`: the user's stop button, recorded as
  `by: "user"`.
- Global, for the phone: `getForwardPorts` is the snapshot,
  `subscribeForwardPorts` a pure change stream of `forwardPorts { ports }`,
  each `{ port, directory, name }`. `unsubscribeForwardPorts`.
- An open request is state, not an event. An event would be lost on every
  device that was not showing the session at that moment, the common case
  when the user switches sessions while the agent works. Each device keeps
  its own record of the requests it has handled (per directory, session
  and origin, the last `at`) and acts on newer ones when the user is in
  that session.
- A request is about the request, never about the user's tabs. The daemon
  does not know which tabs a device has, and the agent must not depend on
  them.

### Desktop

- Tabs opened from a request are the user's tabs, in the user's partition
  (`persist:thinkite-browser`). The agent's own pages, later
  (thinkite/thinkite#31), live elsewhere and never in this panel.
- When the session on screen has requests newer than this device handled:
  - one whose server has stopped since: record it, open nothing;
  - a tab of that session already on the same origin: select it, no reload
    (HMR keeps it current);
  - otherwise add a tab at the URL, or reuse the active tab if it is
    blank. Never navigate a tab the user is on.
  - show the browser panel if it is closed (when something was opened).
  - record every one as handled, whether or not a tab was made. A tab the
    user closes stays closed until the agent asks again.
- After that the tab is an ordinary tab: no following a URL change, no
  closing on stop. A tab on the page of a stopped server (localhost and
  127.0.0.1 count as one host) shows a strip: "web stopped" (no restart
  button in v1).
- The info panel's "Servers" card: a status dot, name, `:<port>` for an
  opened page on this Mac or the host for a tunnel (opens it in a tab),
  state (Running, Stopped, Stopped by agent, Exited (n), Killed), stop.
  Servers never opened (APIs) have no link. Stopped entries stay listed.
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
- **Loading a page:** an entry or request with `localPort` loads as
  `http://localhost:<localPort>` plus the URL's path, through the listener,
  whatever host the agent wrote. Anything else (a tunnel, a public site)
  loads directly.
- Preview screen per session: the project's servers and the session's
  requests from `getPreviews` plus `subscribePreviews`, and a WebView on
  the selected page. No JS bridge to the app: no `onMessage`, no injected
  scripts. The screen's design (server list, banner, manual entry) is
  still open.
- A newer request for the session on screen (same per-device record as the
  desktop): offer to open it. Don't navigate on the user's behalf.
- The selected page's server stopped: show it as stopped and why; don't
  switch to another.

## Later: tab owners

When the agent gets tabs of its own, `browser_open` takes
`owner: "user" | "agent"`, defaulting to `"user"` (no break for existing
calls). User tabs live in the user's browser; with permission the agent may
read and act on them. Agent tabs render off screen for the agent's own
checks; the user cannot operate them (maybe watch read-only). Not added
now: a parameter with one usable value makes the model wonder when to pass
the other.

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
  `browser_open`. That is no more than a link in its reply, opened for the
  user; the tab is in the user's partition, as any page they open.
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
  logs, `browser_open` (a page a server serves, 127.0.0.1, no server on
  the port, a stopped server's port, a tunnel, the latest request per
  session and origin), the project-wide list with "(yours)", stop reasons
  (user, agent, the exit event arriving first, process exit, an outside
  kill), the forward-port list across projects, persistence across a
  restart with an exit in between, the router frames, and the 120
  character first lines.
- **Gated e2e** (`THINKITE_E2E_PROVIDERS=1` style, isolated `opencode
  serve` with `HOME` and the XDG dirs in a temp dir): start, logs, open,
  stop against real shells, and a daemon restart in the middle.
- **Model rerun:** the 10-24 prompts against the real host. Check that the
  agent uses `server_start` rather than shell background, opens pages with
  `browser_open` and not APIs, and that stopping a server from outside
  does not make it start the server again.
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
