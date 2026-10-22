import { Icon } from "@astryxdesign/core/Icon";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "@astryxdesign/core/ToggleButton";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import {
  formatModelRef,
  mintMessageId,
  type PromptParts,
  parseModelRef,
  visibleMessages,
} from "@thinkite/oc-client";
import { useIsRunning, useSession } from "@thinkite/oc-client/react";
import { FileDiffIcon, LayoutListIcon, TerminalIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { type Builtin, Composer, PLACEHOLDER } from "../../components/Composer";
import { DiffPanel } from "../../components/DiffPanel";
import { InfoPanel } from "../../components/InfoPanel";
import {
  findModel,
  inputsOf,
  ModelPicker,
  useDefaultModel,
  useModels,
  VariantPicker,
} from "../../components/ModelPicker";
import { usePendingPrompt } from "../../components/Prompts";
import { SessionTitle } from "../../components/SessionTitle";
import { TerminalPane } from "../../components/TerminalPane";
import {
  type MessageActions,
  TranscriptPanel,
} from "../../components/TranscriptPanel";
import { ocClient, ocReady, ocStore } from "../../lib/oc";

// Session screen: transcript center column with a live composer (opencode
// v2 `session.prompt` through the same-origin `/oc` proxy), and a right
// panel laid out after Claude Code's: buttons at the end of the title bar
// each open one view in it — the session's info cards (shown at first),
// the terminal or the diff — and clicking the open one closes the panel
// (ToggleButtonGroup single mode: deselect → null → closed).
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

type Surface = "info" | "terminal" | "diff";

// Tool-panel UI state is PER SESSION, in memory (the t3code drawer pattern:
// per-thread height/open state, reset on app restart). Keying the Session
// component on the id makes every useState below per-session for free; these
// maps carry the state across remounts within one app run.
const surfaceBySession = new Map<string, Surface | null>();
const panelSizeBySession = new Map<string, number>();
// Every view opens at this width. The info cards stay at it (summaries
// gain nothing from more room); the terminal and diff can be widened.
const PANEL_WIDTH = 320;
// A fork opens with the forked-from prompt in its composer, as opencode's.
const draftForSession = new Map<string, string>();

function SessionRoute() {
  const { sessionId } = Route.useParams();
  return <Session key={sessionId} sessionId={sessionId} />;
}

function Session({ sessionId }: { sessionId: string }) {
  const session = useSession(ocStore, sessionId);
  const running = useIsRunning(ocStore, sessionId);
  // `has` not `??`: null is a real remembered value ("closed"), which `??`
  // would silently swallow. Default for an unvisited session: the info
  // cards, as in Claude Code.
  const [surface, setSurface] = useState<Surface | null>(() =>
    surfaceBySession.has(sessionId)
      ? (surfaceBySession.get(sessionId) as Surface | null)
      : "info",
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

  const toolPanel = useResizable({
    defaultSize: panelSizeBySession.get(sessionId) ?? PANEL_WIDTH,
    minSize: PANEL_WIDTH,
    onSizeChange: (size) => panelSizeBySession.set(sessionId, size),
  });

  // Composer → optimistic send: the user bubble paints at once under a
  // client-minted id, and the durable `session.inbox.enqueued` echo replaces
  // it in place. A rejected send takes the bubble back; here we restore the
  // draft and surface the error in the composer's status slot. Sending while
  // a turn runs queues the message, as in opencode's own clients.
  const [draft, setDraft] = useState(
    () => draftForSession.get(sessionId) ?? "",
  );
  // Taken once mounted (a StrictMode double render reads it twice).
  useEffect(() => {
    draftForSession.delete(sessionId);
  }, [sessionId]);
  const [sendError, setSendError] = useState<string | null>(null);
  // The just-sent prompt's id — TranscriptPanel pins that row near the top
  // while the reply streams below it (anchoredEndSpace). iOS ChatPanel
  // lifecycle: kept across turns (clearing collapses the reserved space and
  // jumps the viewport), replaced by the next send, reset with the
  // per-session remount; only a failed send rolls it back.
  const [anchorUuid, setAnchorUuid] = useState<string | null>(null);
  // A permission request or question waiting on the user takes the
  // composer's place (components/Prompts.tsx).
  const prompt = usePendingPrompt(sessionId);

  const fail = (err: unknown) =>
    setSendError(err instanceof Error ? err.message : String(err));

  const send = (text: string, parts: PromptParts) => {
    if (session === undefined) return Promise.resolve();
    const value = draft;
    setDraft("");
    setSendError(null);
    const userMessageUuid = mintMessageId();
    setAnchorUuid(userMessageUuid);
    return ocStore
      .prompt(sessionId, text, { id: userMessageUuid, ...parts })
      .catch((err: unknown) => {
        setDraft(value);
        setAnchorUuid((cur) => (cur === userMessageUuid ? null : cur));
        fail(err);
        throw err;
      });
  };

  // A service command's user message comes from the service, so there is
  // no bubble to anchor until it lands.
  const runCommand = (name: string, args: string, parts: PromptParts) => {
    const value = draft;
    setDraft("");
    setSendError(null);
    return ocStore.command(sessionId, name, args, parts).catch((err) => {
      setDraft(value);
      fail(err);
      throw err;
    });
  };

  const navigate = useNavigate();

  // opencode's revert puts the prompt back in the composer for an edit and
  // resend, replacing the draft; redo leaves the composer alone.
  const actions: MessageActions = {
    revert: (messageId, text) =>
      ocStore.revert(sessionId, messageId).then(() => {
        setDraft(text);
        setSendError(null);
      }, fail),
    fork: (messageId, text) =>
      ocStore.fork(sessionId, messageId).then((forked) => {
        draftForSession.set(forked.id, text);
        void navigate({
          to: "/session/$sessionId",
          params: { sessionId: forked.id },
        });
      }, fail),
    redo: () => ocStore.unrevert(sessionId).catch(fail),
  };

  // /undo reverts the last prompt still showing, so repeating it walks back.
  const undo = () => {
    const shown = visibleMessages(
      ocStore.session.message.get()[sessionId] ?? [],
      ocStore.session.info.get()[sessionId]?.revert,
    );
    const last = shown.findLast((m) => m.type === "user");
    if (last?.type === "user") void actions.revert(last.id, last.text);
  };

  const builtins: Builtin[] = [
    {
      name: "new",
      description: "Start a new session",
      run: () => void navigate({ to: "/" }),
    },
    {
      name: "compact",
      description: "Summarize the session to free up context",
      run: () => void ocClient.compact(sessionId).catch(fail),
    },
    {
      name: "undo",
      description: "Revert the last message",
      run: undo,
    },
    {
      name: "redo",
      description: "Bring back reverted messages",
      run: () => {
        if (ocStore.session.info.get()[sessionId]?.revert !== undefined)
          void actions.redo();
      },
    },
  ];

  const stop = () => {
    void ocClient.interrupt(sessionId).catch(fail);
  };

  // Model picker: the models the user's connected providers expose, by
  // provider. A pick commits at once through the session's model route;
  // the picked value wins over the live row until the bus push catches up
  // (they converge to equal), and a rejected commit rolls back.
  // A session without a model (made before new sessions pinned one) runs
  // on its folder's default, so the picker shows that. The reasoning
  // variant rides on the same route; a new model starts at its default.
  const models = useModels();
  const [picked, setPicked] = useState<{
    model: string;
    variant: string;
  } | null>(null);
  const pinnedModel =
    picked?.model ??
    (session?.model !== undefined
      ? formatModelRef(session.model.providerID, session.model.id)
      : null);
  const defaultModel = useDefaultModel(
    pinnedModel === null ? (session?.location.directory ?? null) : null,
  );
  const currentModel = pinnedModel ?? defaultModel;
  const currentVariant =
    picked?.variant ?? session?.model?.variant ?? "default";
  const modelInfo = findModel(models, currentModel);

  const switchTo = (model: string, variant: string) => {
    const previous = picked;
    setPicked({ model, variant });
    setSendError(null);
    const ref = {
      ...parseModelRef(model),
      ...(variant !== "default" ? { variant } : {}),
    };
    void ocClient.switchModel(sessionId, ref).catch((err) => {
      setPicked(previous);
      fail(err);
    });
  };
  const pickModel = (model: string) => {
    if (model !== pinnedModel) switchTo(model, "default");
  };
  const pickVariant = (variant: string) => {
    if (currentModel !== null && variant !== currentVariant)
      switchTo(currentModel, variant);
  };

  const pick = (v: string | null) => {
    const s = v === "info" || v === "terminal" || v === "diff" ? v : null;
    setSurface(s);
    if (s === "diff") setDiffVisited(true);
    if (s === "terminal") setTerminalVisited(true);
    surfaceBySession.set(sessionId, s);
  };

  // Row deleted while the screen is open (bus pushed `session.deleted`) —
  // nothing to render; the sidebar link is gone.
  if (session === undefined) return null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Title bar after DeepSeek Harness's, with a rule under it: the
          title and its "…" menu of session actions, where opencode
          desktop puts them, and the panel buttons. It runs the full
          width over the panel too, as Claude Code's does, so the whole
          top row drags the window. */}
      <SessionTitle
        session={session}
        trailing={
          <ToggleButtonGroup
            label="Session panel"
            size="sm"
            value={surface}
            onChange={pick}
          >
            <ToggleButton
              value="info"
              label="Session info"
              isIconOnly
              tooltip="Session info"
              icon={<Icon icon={LayoutListIcon} size="sm" />}
            />
            <ToggleButton
              value="terminal"
              label="Terminal"
              isIconOnly
              tooltip="Terminal"
              icon={<Icon icon={TerminalIcon} size="sm" />}
            />
            <ToggleButton
              value="diff"
              label="Diff"
              isIconOnly
              tooltip="Diff"
              icon={<Icon icon={FileDiffIcon} size="sm" />}
            />
          </ToggleButtonGroup>
        }
      />
      <div className="min-h-0 flex-1">
        <Layout
          height="fill"
          content={
            <LayoutContent padding={0}>
              <div className="flex h-full min-h-0 flex-col">
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
                      actions={actions}
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
                    {prompt ?? (
                      <Composer
                        directory={session?.location.directory ?? null}
                        value={draft}
                        onChange={setDraft}
                        onSend={send}
                        onCommand={runCommand}
                        builtins={builtins}
                        accepts={inputsOf(modelInfo)}
                        onStop={stop}
                        isStopShown={running}
                        placeholder={running ? "Queue a message…" : PLACEHOLDER}
                        error={sendError}
                        footerActions={
                          <>
                            <ModelPicker
                              value={currentModel}
                              onChange={pickModel}
                            />
                            <VariantPicker
                              model={modelInfo}
                              value={currentVariant}
                              onChange={pickVariant}
                            />
                          </>
                        }
                      />
                    )}
                  </div>
                </div>
              </div>
            </LayoutContent>
          }
          end={
            <>
              {surface === "info" ? (
                <div className="w-px shrink-0 bg-[var(--color-border)]" />
              ) : surface !== null ? (
                <ResizeHandle
                  direction="horizontal"
                  hasDivider
                  isReversed
                  isAlwaysVisible={false}
                  resizable={toolPanel.props}
                  label="Resize session panel"
                />
              ) : null}
              {/* Panel body — width-zeroed when closed. The terminal and diff
              stay mounted once opened (terminal buffer) and hide while
              another view shows. Plain div rather than LayoutPanel so
              closing doesn't unmount children. */}
              <div
                style={{
                  width:
                    surface === null
                      ? 0
                      : surface === "info"
                        ? PANEL_WIDTH
                        : toolPanel.size,
                  flexShrink: 0,
                  overflow: "hidden",
                  height: "100%",
                }}
              >
                {surface === "info" ? (
                  <InfoPanel
                    session={session}
                    isRunning={running}
                    onOpenDiff={() => pick("diff")}
                  />
                ) : null}
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
                  <div
                    className={surface === "diff" ? "h-full min-h-0" : "hidden"}
                  >
                    <DiffPanel
                      active={surface === "diff"}
                      dir={session.location.directory}
                    />
                  </div>
                ) : null}
              </div>
            </>
          }
        />
      </div>
    </div>
  );
}
