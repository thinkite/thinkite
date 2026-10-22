import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import {
  DropdownMenu,
  type DropdownMenuOption,
} from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import {
  SideNav,
  SideNavCollapseButton,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { SessionInfo } from "@thinkite/oc-client";
import {
  useConnectionStatus,
  useRunning,
  useSessions,
} from "@thinkite/oc-client/react";
import {
  ArchiveIcon,
  PencilIcon,
  SettingsIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ocClient, ocStore } from "../lib/oc";
import { settingsOpen } from "../lib/prefs";

// Global session sidebar. Content after wisp's — a "New session" action,
// root sessions grouped by how long ago they were last active, one line
// each, the service's status at the bottom — laid out after DeepSeek
// Harness's: 280px wide (264–420), a full-width bordered New session
// button, and a status slot at the start of every row so titles line up.
// Rows come from the store, so new sessions, titles and busy flags appear
// live.

const DAY = 24 * 60 * 60 * 1000;

/** Shown until opencode titles a session (after its first reply). */
export const UNTITLED = "New session";

function groupName(updatedAt: number, now: number): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (updatedAt >= startOfToday) return "Today";
  if (updatedAt >= startOfToday - DAY) return "Yesterday";
  if (updatedAt >= startOfToday - 7 * DAY) return "This week";
  return "Older";
}

/** "opencode 2.1.2" once connected; what is wrong otherwise. */
function useServiceStatus(): { ok: boolean; label: string } {
  const status = useConnectionStatus(ocStore);
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (status !== "ready") return;
    let cancelled = false;
    ocClient
      .info()
      .then((info) => {
        if (!cancelled) setVersion(info.version);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [status]);
  if (status === "ready")
    return { ok: true, label: version ? `opencode ${version}` : "opencode" };
  if (status === "error") return { ok: false, label: "No opencode service" };
  return { ok: false, label: "Connecting…" };
}

/** A fixed slot at the row's start: a dot while the session works. */
function RowStatus({ running }: { running: boolean }) {
  return (
    <span className="inline-flex size-4 items-center justify-center">
      {running ? <StatusDot variant="success" label="Working" /> : null}
    </span>
  );
}

/**
 * One session in the list. Its actions (rename, archive, delete) sit
 * behind a "…" button that shows on hover. The row stays lit while the
 * menu is open, so it's clear which session the menu acts on.
 * Rename edits the title in place, as opencode's sidebar does: Enter or
 * leaving the field saves, Escape cancels.
 */
function SessionRow({
  session,
  isSelected,
  isRunning,
  isBusy,
  onOpen,
  onArchive,
  onDelete,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning: boolean;
  /** An action on it is in flight. */
  isBusy: boolean;
  onOpen: () => void;
  onArchive: () => void;
  /** Asks first; see SessionSidebar. */
  onDelete: () => void;
}) {
  const title = session.title || UNTITLED;
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  // Whether the field is still open: Enter, Escape and the blur that
  // follows each must end it once.
  const editing = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);

  const startRename = () => {
    editing.current = true;
    setDraft(title);
  };
  const endRename = () => {
    editing.current = false;
    setDraft(null);
    // Back on the row, unless the user has moved on (as opencode does).
    requestAnimationFrame(() => {
      if (document.activeElement === document.body)
        rowRef.current?.querySelector("button")?.focus();
    });
  };
  const save = () => {
    if (!editing.current || draft === null) return;
    const next = draft.trim();
    endRename();
    if (next === "" || next === session.title) return;
    // The `session.renamed` bus event updates the row.
    void ocClient
      .renameSession(session.id, next)
      .catch((err) => console.warn("[sidebar] rename failed:", err));
  };

  if (draft !== null)
    return (
      <div className="px-1 py-0.5">
        <TextInput
          label="Session title"
          isLabelHidden
          size="sm"
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
      </div>
    );

  // Delete last, behind a divider, away from the everyday actions.
  const items: DropdownMenuOption[] = [
    { label: "Rename", icon: PencilIcon, onClick: startRename },
    { label: "Archive", icon: ArchiveIcon, onClick: onArchive },
    { type: "divider" },
    {
      label: "Delete…",
      icon: Trash2Icon,
      variant: "destructive",
      onClick: onDelete,
    },
  ];
  return (
    <div
      ref={rowRef}
      className="session-row group"
      data-menu-open={menuOpen || undefined}
    >
      <SideNavItem
        label={title}
        isSelected={isSelected}
        isDisabled={isBusy}
        onClick={onOpen}
        icon={<RowStatus running={isRunning} />}
        actions={
          <span
            className={`transition-opacity group-hover:opacity-100 focus-within:opacity-100 ${menuOpen ? "opacity-100" : "opacity-0"}`}
          >
            {/* MoreMenu's button, without the tooltip it always adds. */}
            <DropdownMenu
              button={{
                label: `More actions for ${title}`,
                icon: <Icon icon="moreHorizontal" size="sm" />,
                variant: "ghost",
                size: "sm",
                isIconOnly: true,
              }}
              hasChevron={false}
              items={items}
              onOpenChange={setMenuOpen}
            />
          </span>
        }
      />
    </div>
  );
}

export function SessionSidebar() {
  const navigate = useNavigate();
  const sessions = useSessions(ocStore);
  const running = useRunning(ocStore);
  const service = useServiceStatus();
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // The session the delete dialog asks about.
  const [confirming, setConfirming] = useState<SessionInfo | null>(null);

  // The sidebar sits outside the route tree, so the open session comes off
  // the location rather than route params.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const selectedId = pathname.match(/^\/session\/([^/]+)$/)?.[1];

  // Archive and delete both take the row away (the `session.archived` or
  // `session.deleted` bus event); leave the session first if it's open.
  const removeWith = (
    id: string,
    action: () => Promise<void>,
    verb: string,
  ) => {
    if (deletingId !== null) return Promise.resolve();
    setDeletingId(id);
    return action()
      .then(() => {
        if (selectedId === id) void navigate({ to: "/" });
      })
      .catch((err) => console.warn(`[sidebar] ${verb} failed:`, err))
      .finally(() => setDeletingId((cur) => (cur === id ? null : cur)));
  };

  // Rows arrive most recently updated first, so groups come out in order.
  // A coarse clock is enough for day boundaries.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const groups = useMemo(() => {
    const out: { name: string; rows: SessionInfo[] }[] = [];
    for (const s of sessions) {
      const name = groupName(s.time.updated, now);
      const last = out.at(-1);
      if (last?.name === name) last.rows.push(s);
      else out.push({ name, rows: [s] });
    }
    return out;
  }, [sessions, now]);

  return (
    <>
      <SideNav
        resizable={{
          autoSaveId: "thinkite:sidebar-width",
          defaultWidth: 280,
          minWidth: 264,
          maxWidth: 420,
        }}
        collapsible={{ hasButton: false }}
        header={
          <div className="flex justify-end">
            <SideNavCollapseButton />
          </div>
        }
        topContent={
          <Button
            label="New session"
            variant="secondary"
            icon={<Icon icon={SquarePenIcon} size="sm" />}
            style={{ width: "100%", justifyContent: "flex-start" }}
            onClick={() => void navigate({ to: "/" })}
          />
        }
        footerIcons={
          <div className="flex w-full min-w-0 items-center gap-2 px-1">
            <Button
              label="Settings"
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<Icon icon={SettingsIcon} size="sm" />}
              onClick={() => settingsOpen.set(true)}
            />
            <div className="flex-1" />
            <StatusDot
              variant={service.ok ? "success" : "neutral"}
              label={service.label}
            />
            <Text size="sm" color="secondary" maxLines={1}>
              {service.label}
            </Text>
          </div>
        }
      >
        {groups.map((g) => (
          <SideNavSection key={g.name} title={g.name}>
            {g.rows.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                isSelected={s.id === selectedId}
                isRunning={running.has(s.id)}
                isBusy={deletingId === s.id}
                onOpen={() =>
                  void navigate({
                    to: "/session/$sessionId",
                    params: { sessionId: s.id },
                  })
                }
                onArchive={() =>
                  void removeWith(
                    s.id,
                    () => ocClient.archiveSession(s.id),
                    "archive",
                  )
                }
                onDelete={() => setConfirming(s)}
              />
            ))}
          </SideNavSection>
        ))}
      </SideNav>
      <AlertDialog
        isOpen={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
        title="Delete session?"
        description={`"${confirming?.title || UNTITLED}" and its history will be deleted. This can't be undone.`}
        actionLabel="Delete session"
        isActionLoading={confirming !== null && deletingId === confirming.id}
        onAction={() => {
          if (confirming === null) return;
          const id = confirming.id;
          return removeWith(
            id,
            () => ocClient.deleteSession(id),
            "delete",
          ).then(() => setConfirming(null));
        }}
      />
    </>
  );
}
