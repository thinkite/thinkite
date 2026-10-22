import { ChatComposer, ChatComposerInput } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { Text } from "@astryxdesign/core/Text";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "@astryxdesign/core/ToggleButton";
import { CommandLineIcon, DocumentPlusIcon } from "@heroicons/react/24/outline";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  formatModelRef,
  mintMessageId,
  parseModelRef,
} from "@thinkite/oc-client";
import { useIsRunning, useSession } from "@thinkite/oc-client/react";
import { useEffect, useState } from "react";
import { DiffPanel } from "../../components/DiffPanel";
import { ModelPicker } from "../../components/ModelPicker";
import { TerminalPane } from "../../components/TerminalPane";
import { TranscriptPanel } from "../../components/TranscriptPanel";
import { ocClient, ocReady, ocStore } from "../../lib/oc";

// Session screen: transcript center column with a live composer (opencode
// v2 `session.prompt` through the same-origin `/oc` proxy), and an
// IntelliJ-style tool-window strip on the right edge — a vertical toggle
// group that both picks the surface (terminal/diff) and closes the panel
// (ToggleButtonGroup single mode: clicking the active button deselects →
// null → closed). The strip stays visible when the panel is closed, so the
// affordance never disappears.
//
// `$sessionId` IS the opencode `ses_*` id, aligned with the iOS routes.
// The loader waits for the first session list (a session created from the
// landing page is already in it); a stale link bounces to the landing page.
// The component then reads the LIVE row so title and busy state keep
// updating while the screen is open.
export const Route = createFileRoute("/session/$sessionId")({
  loader: async ({ params }) => {
    await ocReady.catch(() => {});
    if (ocStore.session.info.get()[params.sessionId] === undefined) {
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
  const session = useSession(ocStore, sessionId);
  const running = useIsRunning(ocStore, sessionId);
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
    minSize: 320,
    onSizeChange: (size) => panelSizeBySession.set(sessionId, size),
  });

  // Composer → optimistic send: the user bubble paints at once under a
  // client-minted id, and the durable `session.inbox.enqueued` echo replaces
  // it in place. A rejected send takes the bubble back; here we restore the
  // draft and surface the error in the composer's status slot. Sending while
  // a turn runs queues the message, as in opencode's own clients.
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  // The just-sent prompt's id — TranscriptPanel pins that row near the top
  // while the reply streams below it (anchoredEndSpace). iOS ChatPanel
  // lifecycle: kept across turns (clearing collapses the reserved space and
  // jumps the viewport), replaced by the next send, reset with the
  // per-session remount; only a failed send rolls it back.
  const [anchorUuid, setAnchorUuid] = useState<string | null>(null);

  const submit = (value: string) => {
    const text = value.trim();
    if (text === "" || session === undefined) return;
    setDraft("");
    setSendError(null);
    const userMessageUuid = mintMessageId();
    setAnchorUuid(userMessageUuid);
    ocStore
      .prompt(sessionId, text, { id: userMessageUuid })
      .catch((err: unknown) => {
        setDraft(value);
        setAnchorUuid((cur) => (cur === userMessageUuid ? null : cur));
        setSendError(err instanceof Error ? err.message : String(err));
      });
  };

  const stop = () => {
    void ocClient.interrupt(sessionId).catch((err) => {
      setSendError(err instanceof Error ? err.message : String(err));
    });
  };

  // Model picker: the models the user's connected providers expose, by
  // provider. A pick commits at once through the session's model route;
  // the picked value wins over the live row until the bus push catches up
  // (they converge to equal), and a rejected commit rolls back.
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const currentModel =
    pickedModel ??
    (session?.model !== undefined
      ? formatModelRef(session.model.providerID, session.model.id)
      : null);

  const pickModel = (model: string) => {
    if (model === currentModel) return;
    const previous = pickedModel;
    setPickedModel(model);
    setSendError(null);
    const ref = parseModelRef(model);
    void ocClient.switchModel(sessionId, ref).catch((err) => {
      setPickedModel(previous);
      setSendError(err instanceof Error ? err.message : String(err));
    });
  };

  const pick = (v: string | null) => {
    const s = v === "terminal" || v === "diff" ? v : null;
    setSurface(s);
    if (s === "diff") setDiffVisited(true);
    if (s === "terminal") setTerminalVisited(true);
    surfaceBySession.set(sessionId, s);
  };

  // Row deleted while the screen is open (bus pushed `session.deleted`) —
  // nothing to render; the sidebar link is gone.
  if (session === undefined) return null;

  return (
    <Layout
      height="fill"
      content={
        <LayoutContent padding={0}>
          <div className="flex h-full min-h-0 flex-col">
            {/* Title bar after DeepSeek Harness's: the title alone, no
                rule under it; the folder lives in the sidebar's context. */}
            <div
              className="flex h-10 shrink-0 items-center px-5"
              title={session.location.directory}
            >
              <Text size="sm" weight="medium" maxLines={1}>
                {session.title || "New session"}
              </Text>
            </div>
            {/* Self-owned transcript shell: the LegendList inside
                TranscriptPanel is the single scroll writer (landing, follow,
                scroll button); the composer is a plain flex sibling — no
                ChatLayout, so nothing else ever touches scrollTop. The whole
                Session subtree remounts per session (SessionRoute key), so
                scroll position, the follow lock, and the draft never
                survive a switch (t3code resets on thread open too).
                Composer slots stay reserved for their rightful owners
                (headerContext = context usage, drawer = attachments); the
                git status bar will wrap this composer in a stack. */}
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="relative min-h-0 flex-1">
                <TranscriptPanel
                  sessionId={sessionId}
                  isRunning={running}
                  anchorUuid={anchorUuid}
                />
                {/* Fade the scrolled content into the actual backdrop just
                    above the composer. `to-surface` (astryx tailwind bridge)
                    = --color-background-surface — what AppShell's content
                    section paints behind the transcript (measured): white in
                    light, #262626 in dark. Theme defaults to mode="system",
                    so a hardcoded white (or card's darker #1b1b1b) would
                    streak in dark mode. Sits below the scroll button (z-10),
                    scroll-transparent. */}
                <div className="chat-col pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-b from-transparent to-surface" />
              </div>
              {/* composer-col = the reading column with half its padding
                  (styles.css): the card sits 32px wider than the text. */}
              <div className="composer-col shrink-0 pb-4">
                <ChatComposer
                  onSubmit={submit}
                  onStop={stop}
                  isStopShown={running}
                  value={draft}
                  onChange={setDraft}
                  placeholder={
                    running ? "Queue a message…" : "Message opencode…"
                  }
                  status={
                    sendError
                      ? { type: "error", message: sendError }
                      : undefined
                  }
                  footerActions={
                    <ModelPicker value={currentModel} onChange={pickModel} />
                  }
                  input={<ChatComposerInput />}
                />
              </div>
            </div>
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
                <TerminalPane
                  sessionId={sessionId}
                  cwd={session.location.directory}
                />
              </div>
            ) : null}
            {diffVisited ? (
              <div className={surface === "diff" ? "h-full min-h-0" : "hidden"}>
                <DiffPanel
                  active={surface === "diff"}
                  dir={session.location.directory}
                />
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
