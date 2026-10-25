# Preview tool v1 — servers the agent starts, opened from desktop and phone

The agent starts dev servers and APIs with its own shell tool, in the
background, and registers them through three tools the daemon serves to
opencode: a name, the shell ID and the URL. The daemon keeps a registry of
them, the desktop opens the pages in its browser panel, and the phone
reaches them through the iroh TCP tunnel from the `forward-tcp-spike`
branch. Letting the agent look at pages itself (screenshots, snapshots,
clicks) is a separate, later piece: thinkite/thinkite#31.

## Goal

- Agent-side: `thinkite_preview_open`, `_list` and `_stop`, served by the
  daemon over opencode's client MCP.
- The daemon's registry is the one list of registered servers per project.
  Desktop and phone subscribe to it.
- Desktop: a server registered with `open` (the default) opens as a tab in
  the session's browser panel. The info panel lists the project's servers,
  with a stop button for each.
- Phone: a preview screen for the session's project. While it is visible,
  every port the project's running shells listen on is forwarded, so a page
  can call its API on another port (the case in the 10-24 test, where the
  page fetched `localhost:8080`), registered or not. The screen has a
  server switcher and manual port entry.

## Non-goals

- No browser tools for the agent (thinkite/thinkite#31).
- The daemon does not start servers. The agent's shell tool does, so
  opencode's own permission check covers the command, and the output, the
  exit notice and the log file are the shell tool's.
- No waiting for readiness and no choosing a port. The agent reads the URL
  from the server's output and passes it; the daemon checks one fact (a URL
  on this Mac is served by that shell) and answers at once.
- No registering servers the agent did not start in a shell of this
  project (nohup, the user's own terminal): the shell ID is required. The
  agent can tell the user such a URL; manual port entry on the phone covers
  them.
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
  through it.
- **10-25, first build.** `preview_start({ name, command, open, port })`:
  the daemon created the shell through `/api/shell` with
  `metadata.thinkite`, polled `ps` + `lsof` for up to 30 s (2 more minutes
  in the background), waited 2 s for the expected port and fell back to the
  nearest listening one. A registry rebuilt from shell metadata.
- **10-25, this design.** The agent already gets a shell ID from the shell
  tool (`Command moved to the background (shell ID: …)`, opencode
  `packages/core/src/tool/plugin/shell.ts`), and the server's output says
  its URL. Passing both makes detection, the grace period, the port rule
  and `preview_logs` unnecessary, and moves the command under opencode's
  shell permission. The cost: the shell's metadata is opencode's (only
  `sessionID`, and there is no API to change it), so the registry keeps its
  own file.

What the experiment settled still holds:

| Finding | Consequence |
|---|---|
| `open: true` only for "let me see" prompts; false for checks and APIs | Keep `open` as a model decision |
| The stub's list showed servers from earlier sessions that were already dead | List checks liveness and filters by session |
| Restarting the stub lost its in-memory registry while the servers kept running | The registry persists (below) |
| `instructions` in the MCP initialize reply never reached the model | Tool descriptions are the only channel |
| Code Mode shows only the first line of each description, cut at 120 characters | Each first line has to stand on its own (below) |
| Each attach/detach injects a ~8.6–8.9k character "catalog changed" notice (anomalyco/opencode#55529) | One persistent connection per directory |
| Tools attached to `proj/web` are invisible to a session at `proj` | Attach to every session's exact directory |
| In Code Mode the call is nested in an `execute` tool row | Clients learn about previews from the registry, not from transcript rows |

The experiment's agents never used the shell tool's background mode,
because `preview_start` was there. Whether they now start in the
background, read the URL and call `preview_open` is the first thing the
model rerun checks.

## Architecture

```
opencode service ──client MCP (WS, per directory)── daemon: PreviewHost
      │  GET/DELETE /api/shell, shell.exited events            │
      │                                                        ├─ Registry (per directory,
      │                                                        │   $THINKITE_HOME/previews.json)
      ▼                                                        ├─ router: subscribePreviews, stopPreview
  dev servers (the agent's background shells)                  ▼
      ▲                                          desktop (in process) / phone (iroh RPC)
      └── thinkite/tcp/1 (IrohTcpTunnel) ◄── phone forwardTcp listeners
```

`PreviewHost` lives in `packages/daemon`, not the desktop, so the tools
work under `thinkite up` too.

```
packages/daemon/src/preview/
  host.ts       connection per directory, events, re-checks
  registry.ts   entries, the URL check, persistence
  ports.ts      process tree → listening ports (ps + lsof -a -p)
  shells.ts     the slice of /api/shell used (get, remove)
  tools.ts      names, descriptions, input schemas
```

## Tools

Tools are named `thinkite_<tool>` (the client name is `thinkite`). In Code
Mode the model calls them as `tools.thinkite.preview_open(…)`. Every call
carries `_meta["ai.opencode/sessionID"]`.

The first lines below are the whole guidance the model sees in the catalog.
Lengths are measured and must stay under 120 characters.

| Tool | First line of the description | Length |
|---|---|---|
| `preview_open` | Show a server you started with the shell tool's background mode in the user's browser: name, shell ID, URL. | 107 |
| `preview_list` | List servers registered with preview_open: URL, status, shell ID, and whether it was shown to the user. | 103 |
| `preview_stop` | Stop a server registered with preview_open: kills its shell and frees its port. | 79 |

`preview_open` continues: "Start the server first (shell tool,
background: true) and wait until its output shows the URL it serves; pass
the shell ID from that result and that URL. open defaults to true; set it
false for an API or other backend the user does not look at, so it still
shows in their Servers list. A URL on this machine must be served by that
shell's processes; a tunnel or public URL is taken as given. Calling again
with the same name and shell shows it again; a running name with another
shell is refused until you preview_stop it."

### `preview_open({ name, shellID, url, open? })`

- `name` is the key, unique per directory. A server is a project resource,
  so a second session can show the same one.
- `shellID` is required: every entry is a shell of this project, so it can
  be stopped and its status is the shell's, not a guess.
  `shell.get(shellID)` with the session's `location.directory`; unknown or
  not running is an error result.
- `url` must be http or https. Then, by host:
  - **This Mac** (`localhost`, `127.x`, `::1`, `*.localhost`, `0.0.0.0`, or
    one of its interface addresses, like Vite's `Network:` line): the
    shell's process tree must listen on the URL's port (`ports.ts`, one
    check, about 40 ms). If not, an error result lists the ports it does
    listen on, or says it listens on none yet, and nothing is registered.
  - **Anything else** (a cloudflared or ngrok tunnel, a public host):
    taken as given. Checking it would mean an HTTP request, and a tunnel
    may need auth.
  - A reverse proxy on this Mac (`https://app.localhost` through Caddy) is
    rejected, since the proxy, not the shell, holds the port. The error's
    port list lets the agent pass `http://localhost:<port>` instead.
- `open` defaults to true: the tool's point is showing. With a session it
  stamps the entry's `opened` (below).
- Same name:
  - **Same shell:** update the URL, add the session, and stamp again if
    `open`. This is how the agent shows a server again.
  - **Another shell, the old one still running:** an error result: "`web`
    is shell sh_…, still running; call preview_stop first or use another
    name." Never kill a server implicitly.
  - **The old one ended:** replace the entry.
- Result: `Registered "web" at http://localhost:5174/. Sent to the user's
  browser.` or `(not opened).` The words must not claim more than the
  daemon knows: it sees the request, not the user's tabs.

### `preview_list({ all? })`

- Default: entries whose `sessions` include the caller. `all: true` lists
  the whole directory. Either way, end with "N more in this project (pass
  all: true)" when some are hidden.
- Re-check each running entry with `shell.get` before answering. A line:
  `web: http://localhost:5173/ — running, shown to the user — shell sh_…,
  \`bun run dev\``; ended ones say `exited (code 1)` or `killed`.

### `preview_stop({ name })`

- `shell.remove`, which kills the process tree. For a server on this Mac,
  wait (up to 3 s) until the tree no longer listens, then mark the entry
  `killed`. It stays, so clients can show it stopped; a later
  `preview_open` of the name replaces it.
- Stopping an entry that already ended answers "not running (exited)".
- If the entry has other sessions, say so in the result: the server
  stopped for them too.
- Stop never touches the user's tabs (see Desktop).

There is no `preview_logs`: the shell tool's result names the output file,
and the agent reads it.

## Registry

```ts
type Entry = {
  directory: string;
  name: string;
  shellID: string;
  pid?: number;
  command: string;            // the shell's
  url: string;                // as the agent gave it, normalized
  localPort?: number;         // set when the URL is on this Mac (checked)
  opened?: { at: number; sessionID: string }; // latest request to show it
  sessions: string[];         // first one first
  status: "running" | "exited" | "killed" | "timeout";
  startedAt: number;          // the shell's start
  exit?: number;
};
```

- **opencode's shells say whether a server runs; everything else lives
  here.** The name, URL, request to show it and sessions exist nowhere
  else, because the shell's metadata is written by the shell tool and
  opencode has no API to change it.
- **Persistence:** every change writes `$THINKITE_HOME/previews.json`
  (atomic rename, mode 600). At start the daemon reads back the entries
  that were running; ones that had already ended are left behind, as an
  in-memory registry would lose them.
- **Liveness:** subscribe to the event bus. On `shell.exited` for a known
  shell, update the entry and push to clients. On attach and every
  reconnect, re-check the directory's running entries with `shell.get`
  (catches exits while the daemon was down), and so do `preview_list` and
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

- The shell's pid from `shell.get`, its descendants from
  `ps -axo pid=,ppid=`, then `lsof -a -p <pids> -nP -iTCP -sTCP:LISTEN
  -Fn`. Each costs about 20 ms (measured 10-24).
- Scoped to the shell's tree, so a port held by another project (Vite on
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
  the tool.
- An entry carries `name`, `url`, `status`, `opened`, `command`,
  `sessions`, `startedAt`, `exit`. No port list: a client that needs the
  port reads it from the URL.
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
- When the session on screen has a running entry with an `opened` stamp
  newer than this device handled:
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
  page on this Mac or the host for a tunnel (opens it in a tab), status,
  stop. Stopped entries stay listed.
- No tunnel: local pages are on this Mac.

### Phone

- Preview screen per session: the list from `getPreviews` plus
  `subscribePreviews`, and a WebView on the selected entry's URL. It has
  no JS bridge to the app: no `onMessage`, no injected scripts.
- While the screen is in the foreground, keep a `forwardTcp` listener for
  every port the project's running shells listen on (the daemon lists the
  directory's shells and their ports; a frame for that comes with the phone
  work), plus manual ones. Backends need no registering for this, which
  matters now that registering is a step the agent can skip. Use the app's
  shared iroh endpoint and the `thinkite/tcp/1` ALPN with the 2-byte port
  header (both from the spike).
  - A URL on this Mac loads as `localhost:<same port>` through the
    listener. A tunnel or public URL loads directly, with no listener.
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

- The server's command runs through the agent's own shell tool, under
  opencode's shell permission. `preview_open` runs nothing; `preview_stop`
  and the stop button kill a shell the agent started.
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
  the local URL check (served, moved port, not listening yet), tunnel URLs,
  unknown and ended shells, showing again, another shell for a running
  name, session filtering, stop, `shell.exited`, persistence across a
  restart with an exit in between, and the 120 character first lines.
- **Gated e2e** (`THINKITE_E2E_PROVIDERS=1` style, isolated `opencode
  serve` with `HOME` and the XDG dirs in a temp dir): a real background
  shell, open, list, stop, and a daemon restart in the middle.
- **Model rerun:** the four 10-24 prompts against the real host. First
  question: does the agent start in the background, wait for the URL and
  call `preview_open`, and does it register backends with `open: false`?
- **Device:**
  - a page on 5180 calling an API on 8080, with HMR, over the tunnel;
  - background/foreground rebinding;
  - Metro's port taken in a dev build.

## Open questions

- Will agents call `preview_open` at all, now that starting works without
  it? If they skip it, the shell tool's result is the only place to hint,
  and that text is opencode's.
- Do phone listeners need to cover ports of other projects? Not in v1: the
  preview screen covers the session's project only.
