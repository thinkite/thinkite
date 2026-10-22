import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { BreadcrumbItem, Breadcrumbs } from "@astryxdesign/core/Breadcrumbs";
import {
  DropdownMenu,
  type DropdownMenuOption,
} from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useNavigate } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { lineageOf, type SessionInfo } from "@thinkite/oc-client";
import { ArchiveIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { ocClient, ocStore } from "../lib/oc";
import { UNTITLED } from "./SessionSidebar";

/** A subagent session's title without the " (@general subagent)" opencode
 *  appends, as opencode desktop shows it. */
function bare(title: string | undefined): string {
  return title?.replace(/\s+\(@[^)]+ subagent\)$/, "") || UNTITLED;
}

/**
 * A subagent session's place: the sessions above it, each a link back,
 * then its own title.
 */
function Lineage({ session }: { session: SessionInfo }) {
  const navigate = useNavigate();
  const above = useSelector(
    ocStore.session.info,
    (all) =>
      lineageOf(session.id, all)
        .slice(1)
        .reverse()
        .map((id) => ({ id, title: all[id]?.title ?? "" })),
    { compare: (a, b) => JSON.stringify(a) === JSON.stringify(b) },
  );
  return (
    <Breadcrumbs label="Session path">
      {above.map((s) => (
        <BreadcrumbItem
          key={s.id}
          onClick={() =>
            void navigate({
              to: "/session/$sessionId",
              params: { sessionId: s.id },
            })
          }
        >
          <span className="inline-block max-w-60 truncate align-bottom">
            {bare(s.title)}
          </span>
        </BreadcrumbItem>
      ))}
      <BreadcrumbItem isCurrent>
        <span className="inline-block max-w-80 truncate align-bottom">
          {bare(session.title)}
        </span>
      </BreadcrumbItem>
    </Breadcrumbs>
  );
}

/**
 * The session screen's title bar: the title, then a "…" menu with the
 * session's actions, as opencode desktop places them. Rename edits the
 * title in place: it starts selected, Enter or leaving the field saves,
 * Escape cancels. Archive and Delete (which asks first) leave the session
 * for the landing page; the bus takes the row out of the sidebar. The
 * panel buttons sit at the far end, where Claude Code puts them. A
 * subagent's session shows its lineage instead, and no actions: it is
 * renamed, archived and deleted with its parent.
 */
export function SessionTitle({
  session,
  trailing,
}: {
  session: SessionInfo;
  /** Controls at the bar's far end (the session panel's buttons). */
  trailing?: ReactNode;
}) {
  const navigate = useNavigate();
  const title = session.title || UNTITLED;
  const [draft, setDraft] = useState<string | null>(null);
  // Whether the field is still open: Enter, Escape and the blur that
  // follows each must end it once.
  const editing = useRef(false);
  const barRef = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const startRename = () => {
    editing.current = true;
    setDraft(title);
  };
  const endRename = () => {
    editing.current = false;
    setDraft(null);
    // Back on the menu button, unless the user has moved on.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body)
        barRef.current?.querySelector("button")?.focus();
    });
  };
  const save = () => {
    if (!editing.current || draft === null) return;
    const next = draft.trim();
    endRename();
    if (next === "" || next === session.title) return;
    // The `session.renamed` bus event updates the title.
    void ocClient
      .renameSession(session.id, next)
      .catch((err) => console.warn("[session] rename failed:", err));
  };

  const leaveWith = (action: () => Promise<void>, verb: string) => {
    setLeaving(true);
    return action()
      .then(() => navigate({ to: "/" }))
      .catch((err) => {
        console.warn(`[session] ${verb} failed:`, err);
        setLeaving(false);
      });
  };

  // Delete last, behind a divider, away from the everyday actions.
  const items: DropdownMenuOption[] = [
    { label: "Rename", icon: PencilIcon, onClick: startRename },
    {
      label: "Archive",
      icon: ArchiveIcon,
      onClick: () =>
        void leaveWith(() => ocClient.archiveSession(session.id), "archive"),
    },
    { type: "divider" },
    {
      label: "Delete…",
      icon: Trash2Icon,
      variant: "destructive",
      onClick: () => setConfirming(true),
    },
  ];

  return (
    <div
      ref={barRef}
      // 48px, so the title centres on y 24 with the sidebar's top row; the
      // bar is one of the window's drag regions (lib/desktop-shell).
      // With the sidebar hidden, --leading-inset clears the traffic lights
      // and the seat beside them (__root).
      className="flex h-12 min-w-0 shrink-0 items-center gap-1 border-b border-[var(--color-border)] pr-5 pl-[var(--leading-inset,1.25rem)]"
      title={session.location.directory}
      data-window-drag
    >
      {session.parentID !== undefined ? (
        <Lineage session={session} />
      ) : draft !== null ? (
        <TextInput
          label="Session title"
          isLabelHidden
          size="sm"
          width="min(100%, 480px)"
          value={draft}
          onChange={setDraft}
          hasAutoFocus
          onFocus={(e) => (e.target as HTMLInputElement).select()}
          onEnter={save}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Escape") endRename();
          }}
        />
      ) : (
        <>
          {/* A one-item breadcrumb, so the title has the same size and
              weight as a subagent session's lineage. */}
          <Breadcrumbs label="Session path">
            <BreadcrumbItem isCurrent>
              <span className="inline-block max-w-120 truncate align-bottom">
                {title}
              </span>
            </BreadcrumbItem>
          </Breadcrumbs>
          {/* MoreMenu's button, without the tooltip it always adds. */}
          <DropdownMenu
            button={{
              label: "Session actions",
              icon: <Icon icon="moreHorizontal" size="sm" />,
              variant: "ghost",
              size: "sm",
              isIconOnly: true,
              isDisabled: leaving,
            }}
            hasChevron={false}
            items={items}
          />
        </>
      )}
      {trailing !== undefined ? (
        <div className="ml-auto flex shrink-0 items-center pl-2">
          {trailing}
        </div>
      ) : null}
      <AlertDialog
        isOpen={confirming}
        onOpenChange={setConfirming}
        title="Delete session?"
        description={`"${title}" and its history will be deleted. This can't be undone.`}
        actionLabel="Delete session"
        isActionLoading={leaving}
        onAction={() =>
          leaveWith(() => ocClient.deleteSession(session.id), "delete").then(
            () => setConfirming(false),
          )
        }
      />
    </div>
  );
}
