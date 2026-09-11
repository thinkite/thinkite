import { Button } from "@astryxdesign/core/Button";
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import {
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { useLiveQuery } from "@tanstack/react-db";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import type { SessionRow } from "@thinkite/oc-client/tanstack";
import { useMemo, useState } from "react";
import {
  evictTranscriptCollection,
  getOcClient,
  sessionStateCollection,
} from "../lib/oc";

// Global session sidebar (t3code-style, grouped by day instead of project).
// Rows come from the opencode session list + `/api/event` bus via the
// session-states collection — new sessions and busy/idle flips appear live,
// no polling. The dot marks sessions opencode is actively working in.

function dayLabel(ts: number, now: Date): string {
  const d = new Date(ts);
  const startOfDay = (x: Date) =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
  });
}

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function basename(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function SessionSidebar() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const { data: sessions } = useLiveQuery((q) =>
    q
      .from({ s: sessionStateCollection })
      .orderBy(({ s }) => s.updatedAt, "desc"),
  );

  // Current session id, straight off the location — the sidebar sits outside
  // the route tree, so route params aren't available via useParams here.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const selectedId = pathname.match(/^\/session\/([^/]+)$/)?.[1];

  const deleteSession = (id: string) => {
    if (deletingId !== null) return;
    setDeletingId(id);
    // v1 compat DELETE (no v2 delete route); the `session.deleted` bus
    // event removes the row. Evict the cached transcript either way so a
    // recreated id never serves stale rows.
    void getOcClient()
      .deleteSession(id)
      .catch((err) => {
        console.warn("[sidebar] delete failed:", err);
      })
      .finally(() => {
        evictTranscriptCollection(id);
        setDeletingId((cur) => (cur === id ? null : cur));
        if (selectedId === id) void navigate({ to: "/" });
      });
  };

  // Day groups, newest first (rows arrive sorted by updatedAt desc).
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? sessions.filter(
          (s) =>
            s.title.toLowerCase().includes(q) ||
            s.directory.toLowerCase().includes(q),
        )
      : sessions;
    const now = new Date();
    const out: { label: string; rows: SessionRow[] }[] = [];
    for (const s of filtered) {
      const label = dayLabel(s.updatedAt, now);
      const last = out.at(-1);
      if (last?.label === label) last.rows.push(s);
      else out.push({ label, rows: [s] });
    }
    return out;
  }, [sessions, query]);

  return (
    <SideNav
      resizable={{ autoSaveId: "sidecode:sidebar-width" }}
      header={<SideNavHeading heading="thinkite" />}
      topContent={
        <div className="flex flex-col gap-2">
          <Button
            label="New session"
            variant="secondary"
            size="sm"
            icon={<PlusIcon />}
            style={{ width: "100%" }}
            onClick={() => void navigate({ to: "/" })}
          />
          <TextInput
            label="Search sessions"
            isLabelHidden
            placeholder="Search"
            size="sm"
            startIcon={MagnifyingGlassIcon}
            value={query}
            onChange={setQuery}
          />
        </div>
      }
    >
      {groups.length === 0 ? (
        <div className="px-3 py-2">
          <Text size="sm" color="secondary">
            {query ? "No matches." : "No sessions yet."}
          </Text>
        </div>
      ) : (
        groups.map((g) => (
          <SideNavSection key={g.label} title={g.label}>
            {g.rows.map((s) => (
              <SideNavItem
                key={s.id}
                label={s.title === "" ? "Untitled session" : s.title}
                isSelected={s.id === selectedId}
                onClick={() =>
                  void navigate({
                    to: "/session/$sessionId",
                    params: { sessionId: s.id },
                  })
                }
                endContent={
                  // SideNavItem has no secondary line or row actions, so
                  // the directory basename + updated time stack in the
                  // trailing slot; delete reveals on hover/focus of this
                  // cluster (always visible while deleting).
                  <span className="group/meta flex items-center gap-1">
                    <span className="flex flex-col items-end">
                      <Text size="xsm" color="secondary" maxLines={1}>
                        {basename(s.directory)}
                      </Text>
                      {s.activity === "running" ? (
                        <StatusDot variant="success" label="opencode running" />
                      ) : deletingId === s.id ? (
                        <Text size="xsm" color="secondary">
                          Deleting…
                        </Text>
                      ) : (
                        <Text size="xsm" color="secondary">
                          {timeLabel(s.updatedAt)}
                        </Text>
                      )}
                    </span>
                    {deletingId === s.id ? null : (
                      // SideNavItem already renders a <button>; a nested
                      // <button> is invalid HTML (React warns, hydration
                      // breaks), so the delete affordance is a keyboard-
                      // reachable span.
                      // biome-ignore lint/a11y/useSemanticElements: a <button> here would nest inside SideNavItem's <button> (invalid HTML, React hydration error)
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={`Delete ${s.title === "" ? "untitled session" : s.title}`}
                        title="Delete session"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteSession(s.id);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== "Enter" && e.key !== " ") return;
                          e.preventDefault();
                          e.stopPropagation();
                          deleteSession(s.id);
                        }}
                        className="inline-flex cursor-pointer rounded p-0.5 opacity-0 transition-opacity group-hover/meta:opacity-100 focus-visible:opacity-100"
                      >
                        <TrashIcon className="h-3.5 w-3.5 opacity-60" />
                      </span>
                    )}
                  </span>
                }
              />
            ))}
          </SideNavSection>
        ))
      )}
    </SideNav>
  );
}
