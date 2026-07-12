import {
  ChatComposer,
  ChatComposerInput,
  ChatLayout,
} from "@astryxdesign/core/Chat";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { Text } from "@astryxdesign/core/Text";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "@astryxdesign/core/ToggleButton";
import { CommandLineIcon, DocumentPlusIcon } from "@heroicons/react/24/outline";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { DiffPanel } from "../../components/DiffPanel";
import { TerminalPane } from "../../components/TerminalPane";
import { TranscriptPanel } from "../../components/TranscriptPanel";
import { sessionStateCollection } from "../../lib/sessions-collection";

// Session screen: transcript center column with a UI-only composer, and an
// IntelliJ-style tool-window strip on the right edge — a vertical toggle
// group that both picks the surface (terminal/diff) and closes the panel
// (ToggleButtonGroup single mode: clicking the active button deselects →
// null → closed). The strip stays visible when the panel is closed, so the
// affordance never disappears.
//
// `$sessionId` IS the Claude Code session uuid (cliSessionId) — the
// collection key, aligned with the iOS routes. The loader gates on the
// collection's first snapshot; a stale link bounces to the landing page.
// The component then reads the LIVE row so title / activity keep updating
// while the screen is open.
export const Route = createFileRoute("/session/$sessionId")({
  loader: async ({ params }) => {
    await sessionStateCollection.preload();
    if (sessionStateCollection.get(params.sessionId) === undefined) {
      throw redirect({ to: "/" });
    }
  },
  component: SessionRoute,
});

type Surface = "terminal" | "diff";

// Tool-panel UI state is PER SESSION, in memory (the t3code drawer pattern:
// per-thread height/open state, reset on app restart). Keying the Session
// component on the id makes every useState below per-session for free; these
// maps carry the state across remounts within one app run.
const surfaceBySession = new Map<string, Surface | null>();
const panelSizeBySession = new Map<string, number>();

function SessionRoute() {
  const { sessionId } = Route.useParams();
  return <Session key={sessionId} sessionId={sessionId} />;
}

function Session({ sessionId }: { sessionId: string }) {
  const { data: rows } = useLiveQuery(
    (q) =>
      q
        .from({ s: sessionStateCollection })
        .where(({ s }) => eq(s.cliSessionId, sessionId)),
    [sessionId],
  );
  const session = rows[0];
  // `has` not `??`: null is a real remembered value ("closed"), which `??`
  // would silently swallow. Default for an unvisited session: closed.
  const [surface, setSurface] = useState<Surface | null>(() =>
    surfaceBySession.has(sessionId)
      ? (surfaceBySession.get(sessionId) as Surface | null)
      : null,
  );
  // Both surfaces mount on FIRST VISIT and stay mounted (t3code's drawer
  // pattern: `return null` until terminalOpen). For the terminal that
  // structural gate IS the lazy attach — an unopened panel never mounts,
  // never connects, never spawns a shell; after first open it stays mounted
  // so closing the panel keeps the xterm buffer instead of re-replaying
  // the scrollback ring.
  const [diffVisited, setDiffVisited] = useState(surface === "diff");
  const [terminalVisited, setTerminalVisited] = useState(
    surface === "terminal",
  );

  const rightPanel = useResizable({
    defaultSize: panelSizeBySession.get(sessionId) ?? 560,
    minSizePx: 320,
    onSizeChange: (size) => panelSizeBySession.set(sessionId, size),
  });

  const pick = (v: string | null) => {
    const s = v === "terminal" || v === "diff" ? v : null;
    setSurface(s);
    if (s === "diff") setDiffVisited(true);
    if (s === "terminal") setTerminalVisited(true);
    surfaceBySession.set(sessionId, s);
  };

  // Row deleted while the screen is open (daemon-side delete pushed a
  // session_state_removed) — nothing to render; the sidebar link is gone.
  if (session === undefined) return null;

  return (
    <Layout
      height="fill"
      content={
        <LayoutContent padding={0}>
          <div className="flex h-full min-h-0 flex-col">
            {/* Tailwind borders default to currentColor (near-black); pin
                them to the astryx token so they match component dividers. */}
            <div
              className="flex items-center gap-3 border-b px-4 py-2"
              style={{ borderColor: "var(--color-border)" }}
            >
              <div className="flex min-w-0 items-baseline gap-3">
                <Heading level={5} maxLines={1}>
                  {session.title}
                </Heading>
                <Text size="sm" color="secondary" maxLines={1}>
                  {session.cwd}
                </Text>
              </div>
            </div>
            {/* ChatLayout owns the transcript scroll container (stick-to-
                bottom + scroll button) and docks the UI-only composer —
                wired to the daemon chat pipeline later. The whole Session
                subtree remounts per session (SessionRoute key), so scroll
                position and the follow lock never survive a switch
                (t3code resets to following-end on thread open too). */}
            <ChatLayout
              className="min-h-0 flex-1"
              composer={
                <ChatComposer
                  onSubmit={() => {}}
                  placeholder="Chat coming soon — use the terminal for now"
                  input={<ChatComposerInput />}
                />
              }
            >
              <TranscriptPanel dir={session.cwd} claudeSessionId={sessionId} />
            </ChatLayout>
          </div>
        </LayoutContent>
      }
      end={
        <>
          {surface !== null && (
            <ResizeHandle
              direction="horizontal"
              hasDivider
              isReversed
              isAlwaysVisible={false}
              resizable={rightPanel.props}
              label="Resize tool panel"
            />
          )}
          {/* Panel body — always mounted (terminal buffer), width-zeroed when
              closed. Plain div rather than LayoutPanel so closing doesn't
              unmount children. */}
          <div
            style={{
              width: surface === null ? 0 : rightPanel.size,
              flexShrink: 0,
              overflow: "hidden",
              height: "100%",
            }}
          >
            {terminalVisited ? (
              <div
                className={
                  surface === "terminal" ? "h-full min-h-0 p-2" : "hidden"
                }
              >
                <TerminalPane sessionId={sessionId} cwd={session.cwd} />
              </div>
            ) : null}
            {diffVisited ? (
              <div className={surface === "diff" ? "h-full min-h-0" : "hidden"}>
                <DiffPanel active={surface === "diff"} dir={session.cwd} />
              </div>
            ) : null}
          </div>
          {/* IntelliJ-style tool-window strip: always visible, single-select,
              re-click deselects → closes the panel. */}
          <div
            className="flex h-full shrink-0 flex-col items-center border-l px-1 py-2"
            style={{ borderColor: "var(--color-border)" }}
          >
            <ToggleButtonGroup
              label="Tool windows"
              orientation="vertical"
              size="lg"
              value={surface}
              onChange={pick}
            >
              <ToggleButton
                value="terminal"
                label="Terminal"
                isIconOnly
                tooltip="Terminal"
                icon={<Icon icon={CommandLineIcon} size="md" />}
              />
              <ToggleButton
                value="diff"
                label="Diff"
                isIconOnly
                tooltip="Diff"
                icon={<Icon icon={DocumentPlusIcon} size="md" />}
              />
            </ToggleButtonGroup>
          </div>
        </>
      }
    />
  );
}
