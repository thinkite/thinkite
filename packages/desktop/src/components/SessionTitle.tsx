import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import {
  DropdownMenu,
  type DropdownMenuOption,
} from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useNavigate } from "@tanstack/react-router";
import type { SessionInfo } from "@thinkite/oc-client";
import { ArchiveIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useRef, useState } from "react";
import { ocClient } from "../lib/oc";
import { UNTITLED } from "./SessionSidebar";

/**
 * The session screen's title bar: the title, then a "…" menu with the
 * session's actions, as opencode desktop places them. Rename edits the
 * title in place: it starts selected, Enter or leaving the field saves,
 * Escape cancels. Archive and Delete (which asks first) leave the session
 * for the landing page; the bus takes the row out of the sidebar.
 */
export function SessionTitle({ session }: { session: SessionInfo }) {
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
      className="flex h-10 min-w-0 shrink-0 items-center gap-1 px-5"
      title={session.location.directory}
    >
      {draft !== null ? (
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
          <Text size="sm" weight="medium" maxLines={1}>
            {title}
          </Text>
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
