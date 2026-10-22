import { Button } from "@astryxdesign/core/Button";
import { ContextMenu } from "@astryxdesign/core/ContextMenu";
import { Icon } from "@astryxdesign/core/Icon";
import {
  SideNav,
  SideNavCollapseButton,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { SessionInfo } from "@thinkite/oc-client";
import {
  useConnectionStatus,
  useRunning,
  useSessions,
} from "@thinkite/oc-client/react";
import { SettingsIcon, SquarePenIcon, Trash2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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

export function SessionSidebar() {
  const navigate = useNavigate();
  const sessions = useSessions(ocStore);
  const running = useRunning(ocStore);
  const service = useServiceStatus();
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // The sidebar sits outside the route tree, so the open session comes off
  // the location rather than route params.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const selectedId = pathname.match(/^\/session\/([^/]+)$/)?.[1];

  const deleteSession = (id: string) => {
    if (deletingId !== null) return;
    setDeletingId(id);
    // The `session.deleted` bus event removes the row.
    void ocClient
      .deleteSession(id)
      .catch((err) => {
        console.warn("[sidebar] delete failed:", err);
      })
      .finally(() => {
        setDeletingId((cur) => (cur === id ? null : cur));
        if (selectedId === id) void navigate({ to: "/" });
      });
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
          {g.rows.map((s) => {
            const title = s.title || UNTITLED;
            // Delete lives on the row's context menu, so rows stay one quiet line.
            return (
              <ContextMenu
                key={s.id}
                label={`Actions for ${title}`}
                items={[
                  {
                    label: "Delete session",
                    icon: Trash2Icon,
                    variant: "destructive",
                    onClick: () => deleteSession(s.id),
                  },
                ]}
              >
                <SideNavItem
                  label={title}
                  isSelected={s.id === selectedId}
                  isDisabled={deletingId === s.id}
                  onClick={() =>
                    void navigate({
                      to: "/session/$sessionId",
                      params: { sessionId: s.id },
                    })
                  }
                  icon={<RowStatus running={running.has(s.id)} />}
                />
              </ContextMenu>
            );
          })}
        </SideNavSection>
      ))}
    </SideNav>
  );
}
