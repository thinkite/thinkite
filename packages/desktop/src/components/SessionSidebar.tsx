import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import {
  SideNav,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { isUnread, rootOf, type SessionInfo } from "@thinkite/oc-client";
import {
  useConnectionStatus,
  useFailed,
  useRunning,
  useSessions,
  useWaiting,
} from "@thinkite/oc-client/react";
import { PanelLeftCloseIcon, SettingsIcon, SquarePenIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { ocClient, ocStore } from "../lib/oc";
import { settingsOpen, updatePrefs } from "../lib/prefs";
import { UNREAD_SINCE } from "../lib/unread";

// Global session sidebar. Content after wisp's — a "New session" action,
// root sessions grouped by how long ago they were last active, one line
// each, the service's status at the bottom — laid out after DeepSeek
// Harness's: 280px wide (264–420), a full-width bordered New session
// button, and a status slot at the start of every row so titles line up.
// Rows come from the store, so new sessions, titles and each row's status
// (waiting for you, working, failed, new reply) appear live.

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

type RowState = "waiting" | "running" | "failed" | "unread";

/** What the row's status slot shows, most urgent first: a permission
 *  request or question waiting (on the session or a subagent of it), a
 *  turn in flight, then a finished turn not looked at yet — failed or not. */
function rowState(
  s: SessionInfo,
  waiting: ReadonlySet<string>,
  running: ReadonlySet<string>,
  failed: Readonly<Record<string, true>>,
): RowState | null {
  if (waiting.has(s.id)) return "waiting";
  if (running.has(s.id)) return "running";
  if (!isUnread(s, UNREAD_SINCE)) return null;
  return failed[s.id] ? "failed" : "unread";
}

/** A fixed slot at the row's start, so titles line up. */
function RowStatus({ state }: { state: RowState | null }) {
  return (
    <span className="inline-flex size-4 items-center justify-center">
      {state === "waiting" ? (
        <StatusDot variant="warning" label="Waiting for you" />
      ) : state === "running" ? (
        <span className="inline-flex" title="Working">
          <Spinner size="sm" shade="subtle" />
        </span>
      ) : state === "failed" ? (
        <StatusDot variant="error" label="Failed" />
      ) : state === "unread" ? (
        <StatusDot variant="accent" label="New reply" />
      ) : null}
    </span>
  );
}

export function SessionSidebar() {
  const navigate = useNavigate();
  const sessions = useSessions(ocStore);
  const running = useRunning(ocStore);
  const waiting = useWaiting(ocStore);
  const failed = useFailed(ocStore);
  const service = useServiceStatus();

  // The sidebar sits outside the route tree, so the open session comes off
  // the location rather than route params.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const openId = pathname.match(/^\/session\/([^/]+)$/)?.[1];
  // A subagent's session isn't listed: its root's row stays selected.
  const selectedId = useSelector(ocStore.session.info, (all) =>
    openId === undefined ? undefined : rootOf(openId, all),
  );

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
      // The window's top row: the traffic lights at its start (Electron
      // places them), the collapse button at its end, both centred on
      // y 24. The negative margins take back the nav's 8px padding so the
      // whole row drags.
      header={
        <div
          className="-mx-2 -mt-2 flex h-12 items-center justify-end px-2"
          data-window-drag
        >
          <Button
            label="Collapse sidebar"
            variant="ghost"
            size="sm"
            isIconOnly
            icon={<Icon icon={PanelLeftCloseIcon} size="sm" />}
            onClick={() =>
              updatePrefs((p) => ({ ...p, sidebar: { collapsed: true } }))
            }
          />
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
          {/* Session actions live in the session's title bar, so rows
              stay one quiet line. */}
          {g.rows.map((s) => (
            <SideNavItem
              key={s.id}
              label={s.title || UNTITLED}
              isSelected={s.id === selectedId}
              onClick={() =>
                void navigate({
                  to: "/session/$sessionId",
                  params: { sessionId: s.id },
                })
              }
              icon={<RowStatus state={rowState(s, waiting, running, failed)} />}
            />
          ))}
        </SideNavSection>
      ))}
    </SideNav>
  );
}
