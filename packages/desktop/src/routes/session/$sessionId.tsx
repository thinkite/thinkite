import { useState } from "react";
import { createFileRoute, redirect } from "@tanstack/react-router";
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
import {
  CommandLineIcon,
  DocumentPlusIcon,
} from "@heroicons/react/24/outline";
import { DiffPanel } from "../../components/DiffPanel";
import { TerminalPane } from "../../components/TerminalPane";
import { TranscriptPanel } from "../../components/TranscriptPanel";
import { fetchSessions } from "../../lib/sessions";

// Session screen: transcript center column with a UI-only composer, and an
// IntelliJ-style tool-window strip on the right edge — a vertical toggle
// group that both picks the surface (terminal/diff) and closes the panel
// (ToggleButtonGroup single mode: clicking the active button deselects →
// null → closed). The strip stays visible when the panel is closed, so the
// affordance never disappears. The session record is the daemon's (read-only
// mirror); a stale link bounces back to the landing page.
export const Route = createFileRoute("/session/$sessionId")({
  loader: async ({ params }) => {
    const rows = await fetchSessions();
    const session = rows.find((s) => s.id === params.sessionId);
    if (!session) throw redirect({ to: "/" });
    return session;
  },
  component: Session,
});

type Surface = "terminal" | "diff";
const SURFACE_KEY = "sidecode:session-right-surface";

function loadSurface(): Surface | null {
  const v = localStorage.getItem(SURFACE_KEY);
  return v === "terminal" || v === "diff" ? v : v === "" ? null : "terminal";
}

function Session() {
  const session = Route.useLoaderData();
  const [surface, setSurface] = useState<Surface | null>(loadSurface);
  // Diff mounts on first visit and stays mounted (preserves scroll; refetch
  // is the panel's own concern). The terminal NEVER unmounts — dropping it
  // would lose the xterm buffer and re-replay the scrollback ring — so
  // closing the panel only zeroes the container width.
  const [diffVisited, setDiffVisited] = useState(surface === "diff");

  const rightPanel = useResizable({
    defaultSize: 560,
    minSizePx: 320,
    autoSaveId: "sidecode:session-right-panel",
  });

  const pick = (v: string | null) => {
    const s = v === "terminal" || v === "diff" ? v : null;
    setSurface(s);
    if (s === "diff") setDiffVisited(true);
    localStorage.setItem(SURFACE_KEY, s ?? "");
  };

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
                wired to the daemon chat pipeline later. Keyed by session so
                a switch remounts it: scroll position and the follow lock
                are per-session state, not survivors of the previous one
                (t3code resets to following-end on thread open too). */}
            <ChatLayout
              key={session.id}
              className="min-h-0 flex-1"
              composer={
                <ChatComposer
                  onSubmit={() => {}}
                  placeholder="Chat coming soon — use the terminal for now"
                  input={<ChatComposerInput />}
                />
              }
            >
              <TranscriptPanel
                dir={session.cwd}
                claudeSessionId={session.claudeSessionId}
              />
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
            <div
              className={
                surface === "terminal" ? "h-full min-h-0 p-2" : "hidden"
              }
            >
              <TerminalPane sessionId={session.id} />
            </div>
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
