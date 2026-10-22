import { ChatComposer, ChatComposerInput } from "@astryxdesign/core/Chat";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
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
  CheckIcon,
  CommandLineIcon,
  DocumentPlusIcon,
} from "@heroicons/react/24/outline";
import { eq, useLiveQuery } from "@tanstack/react-db";
import { createFileRoute, redirect } from "@tanstack/react-router";
import {
  formatModelRef,
  mintMessageId,
  parseModelRef,
} from "@thinkite/oc-client";
import { useEffect, useState } from "react";
import { DiffPanel } from "../../components/DiffPanel";
import { TerminalPane } from "../../components/TerminalPane";
import { TranscriptPanel } from "../../components/TranscriptPanel";
import {
  getOcClient,
  sendUserMessage,
  sessionStateCollection,
} from "../../lib/oc";

// Session screen: transcript center column with a live composer (opencode
// v2 `session.prompt` through the same-origin `/oc` proxy), and an
// IntelliJ-style tool-window strip on the right edge — a vertical toggle
// group that both picks the surface (terminal/diff) and closes the panel
// (ToggleButtonGroup single mode: clicking the active button deselects →
// null → closed). The strip stays visible when the panel is closed, so the
// affordance never disappears.
//
// `$sessionId` IS the opencode `ses_*` id — the collection key, aligned
// with the iOS routes. The loader gates on the collection's first snapshot
// (plus a short wait for the create→navigate race); a stale link bounces
// to the landing page. The component then reads the LIVE row so title /
// activity keep updating while the screen is open.
export const Route = createFileRoute("/session/$sessionId")({
  loader: async ({ params }) => {
    await sessionStateCollection.preload();
    if (sessionStateCollection.get(params.sessionId) !== undefined) return;
    // Created from the landing page a beat ago: the `session.created` bus
    // event may not have landed yet. Poll briefly before giving up.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      if (sessionStateCollection.get(params.sessionId) !== undefined) return;
    }
    throw redirect({ to: "/" });
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

interface ModelOption {
  value: string;
  label: string;
  description: string;
}

function useModelOptions(): ModelOption[] | null {
  const [options, setOptions] = useState<ModelOption[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const client = getOcClient();
        const [providers, models] = await Promise.all([
          client.listProviders(),
          client.listModels(),
        ]);
        if (cancelled) return;
        const names = new Map(providers.map((p) => [p.id, p.name]));
        setOptions(
          models
            .filter((m) => m.enabled && m.status !== "deprecated")
            .map((m) => ({
              value: formatModelRef(m.providerID, m.id),
              label: m.name,
              description: `${names.get(m.providerID) ?? m.providerID} · ${m.providerID}/${m.id}`,
            }))
            .sort((a, b) => (a.label < b.label ? -1 : 1)),
        );
      } catch (err) {
        console.warn("[session] model list failed:", err);
        if (!cancelled) setOptions([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return options;
}

function SessionRoute() {
  const { sessionId } = Route.useParams();
  return <Session key={sessionId} sessionId={sessionId} />;
}

function Session({ sessionId }: { sessionId: string }) {
  const { data: rows } = useLiveQuery(
    (q) =>
      q
        .from({ s: sessionStateCollection })
        .where(({ s }) => eq(s.id, sessionId)),
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
    minSize: 320,
    onSizeChange: (size) => panelSizeBySession.set(sessionId, size),
  });

  // Composer → optimistic send (lib/oc.ts): the user
  // bubble paints synchronously via the collection's optimistic overlay
  // under a client-minted input id; the durable `prompt.admitted` event
  // (same id as `messageID`) lands on it seamlessly through the session
  // stream. A rejected send auto-rolls the bubble back — here we just
  // restore the draft and surface the error in the composer's status slot.
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
    // Not `isDisabled={running}`: Astryx's disabled composer swallows
    // pointer events for the Stop button too. Refusing here keeps Stop
    // clickable while a turn runs (queued prompts are a later slice).
    if (running) return;
    if (text === "" || session === undefined) return;
    setDraft("");
    setSendError(null);
    const userMessageUuid = mintMessageId();
    setAnchorUuid(userMessageUuid);
    const tx = sendUserMessage({
      sessionId,
      userMessageUuid,
      text,
    });
    void tx.isPersisted.promise.catch((err: unknown) => {
      setDraft(value);
      setAnchorUuid((cur) => (cur === userMessageUuid ? null : cur));
      setSendError(err instanceof Error ? err.message : String(err));
    });
  };

  const stop = () => {
    void getOcClient()
      .interrupt(sessionId)
      .catch((err) => {
        setSendError(err instanceof Error ? err.message : String(err));
      });
  };

  // Model picker (official astryx pattern: DropdownMenu in footerActions,
  // like the ai-chat template's mode picker). Options are the models the
  // user's connected providers expose (`/api/provider` + `/api/model`);
  // current is the session's live model. Selection commits at PICK time
  // via the v2 model route — sendPrompt carries no model (source wins over
  // the brief's sketch). The optimistic value wins over the live row until
  // the bus push catches up (they converge to equal); a rejected commit
  // rolls back to the previous pick.
  const modelOptions = useModelOptions();
  const [pickedModel, setPickedModel] = useState<string | null>(null);
  const currentModel = pickedModel ?? session?.model ?? null;

  const pickModel = (model: string) => {
    if (model === currentModel) return;
    const previous = pickedModel;
    setPickedModel(model);
    setSendError(null);
    const ref = parseModelRef(model);
    void getOcClient()
      .switchModel(sessionId, ref)
      .catch((err) => {
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

  const running = session.activity === "running";

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
                  {session.title === "" ? "Untitled session" : session.title}
                </Heading>
                <Text size="sm" color="secondary" maxLines={1}>
                  {session.directory}
                </Text>
              </div>
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
              {/* chat-col = the shared reading column (styles.css), so the
                  composer aligns with the transcript rows. */}
              <div className="chat-col shrink-0 pb-3">
                <ChatComposer
                  onSubmit={submit}
                  onStop={stop}
                  isStopShown={running}
                  value={draft}
                  onChange={setDraft}
                  placeholder={
                    running ? "opencode is working…" : "Message opencode…"
                  }
                  status={
                    sendError
                      ? { type: "error", message: sendError }
                      : undefined
                  }
                  footerActions={
                    <DropdownMenu
                      button={{
                        label:
                          currentModel !== null
                            ? (modelOptions?.find(
                                (o) => o.value === currentModel,
                              )?.label ?? currentModel)
                            : "Model",
                        variant: "ghost",
                        size: "sm",
                      }}
                      items={(modelOptions ?? []).map((m) => ({
                        label: m.label,
                        description: m.description,
                        icon:
                          currentModel !== null && m.value === currentModel
                            ? CheckIcon
                            : undefined,
                        onClick: () => pickModel(m.value),
                      }))}
                    />
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
                <TerminalPane sessionId={sessionId} cwd={session.directory} />
              </div>
            ) : null}
            {diffVisited ? (
              <div className={surface === "diff" ? "h-full min-h-0" : "hidden"}>
                <DiffPanel
                  active={surface === "diff"}
                  dir={session.directory}
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
