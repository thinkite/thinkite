import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import {
  createRootRoute,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { useWaiting } from "@thinkite/oc-client/react";
import { PanelLeftOpenIcon, SquarePenIcon } from "lucide-react";
import { type CSSProperties, useEffect } from "react";
import { PierrePool } from "../components/PierrePool";
import { SessionSidebar } from "../components/SessionSidebar";
import { Settings } from "../components/settings/Settings";
import { isDesktopShell } from "../lib/desktop-shell";
import { ocStore } from "../lib/oc";
import { prefs, settingsOpen, updatePrefs } from "../lib/prefs";
import { readyVersion, useUpdate } from "../lib/update";

// Routes that render in their OWN BrowserWindow (tray-opened dialogs) —
// bare content, no app chrome. Everything else gets the AppShell + global
// sidebar.
const BARE_ROUTES = new Set(["/pair"]);

export const Route = createRootRoute({
  // PierrePool at the root: the pool is a refcounted module singleton — were
  // it mounted per-route, leaving the route would terminate the workers and
  // the next visit would cold-boot them again. Root placement initializes
  // once at app launch and every diff surface (session Diff tab, P2
  // transcript tool-call diffs) shares the warm pool.
  //
  // AppShell + SessionSidebar live here too: the sidebar is global chrome
  // (t3code-style), not route content — it survives navigation, so xterm-less
  // routes and session routes share one list and one resize state.
  component: RootLayout,
});

// Electron hiddenInset: the window has a transparent titlebar. Nothing is
// pushed down for it: the traffic lights sit in the sidebar's top row, and
// that row, the session title bar and the landing page's top row are the
// window's drag regions (lib/desktop-shell).

function RootLayout() {
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  if (BARE_ROUTES.has(pathname)) {
    return <Outlet />;
  }
  return (
    <PierrePool>
      <RootChrome />
    </PierrePool>
  );
}

/** ⌘N opens a new session, ⌘, the settings. */
function useAppShortcuts() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey) return;
      if (e.key === "n") {
        e.preventDefault();
        void navigate({ to: "/" });
      } else if (e.key === ",") {
        e.preventDefault();
        settingsOpen.set(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate]);
}

// The traffic lights end at x 77; the seat starts a little after them.
const SEAT_LEFT = isDesktopShell ? 84 : 8;

/**
 * With the sidebar hidden, its two buttons wait in the window's top row,
 * after the traffic lights (DeepSeek Harness's leading seat): bring the
 * sidebar back, or start a new session.
 */
function LeadingSeat() {
  const navigate = useNavigate();
  // The sidebar's update button is hidden with it; a dot on the expand
  // button says one is ready (after DeepSeek Harness's badge).
  const update = useUpdate();
  const ready = update !== null && readyVersion(update.state) !== undefined;
  return (
    <div
      // top 10 centres the 28px buttons on y 24, with the lights.
      className="fixed top-2.5 z-20 flex items-center gap-1"
      style={{ left: SEAT_LEFT }}
      // Floats over the title bar's drag row; its buttons must click.
      data-window-no-drag
    >
      <span className="relative inline-flex">
        <Button
          label="Expand sidebar"
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<Icon icon={PanelLeftOpenIcon} size="sm" />}
          onClick={() =>
            updatePrefs((p) => ({ ...p, sidebar: { collapsed: false } }))
          }
        />
        {ready ? (
          <span className="pointer-events-none absolute top-0.5 right-0.5 inline-flex">
            <StatusDot variant="accent" label="Update ready" />
          </span>
        ) : null}
      </span>
      <Button
        label="New session"
        variant="ghost"
        size="sm"
        isIconOnly
        icon={<Icon icon={SquarePenIcon} size="sm" />}
        onClick={() => void navigate({ to: "/" })}
      />
    </div>
  );
}

/** The Dock badge counts the sessions waiting for an answer from the user
 *  (a permission request or a question, theirs or a subagent's). */
function useDockBadge() {
  const waiting = useWaiting(ocStore).size;
  useEffect(() => {
    if (!isDesktopShell) return;
    void fetch(`/api/badge?count=${waiting}`, { method: "POST" }).catch(
      () => {},
    );
  }, [waiting]);
}

function RootChrome() {
  useAppShortcuts();
  useDockBadge();
  // Collapsed means gone, not a rail: AppShell takes no sideNav, and the
  // top rows start after the seat (two 28px buttons and a gap).
  const collapsed = useSelector(prefs, (p) => p.sidebar.collapsed);
  const style = collapsed
    ? ({ "--leading-inset": `${SEAT_LEFT + 76}px` } as CSSProperties)
    : undefined;
  return (
    <AppShell
      style={style}
      height="fill"
      contentPadding={0}
      variant="section"
      // Desktop app — never trade the sidebar for a mobile drawer. NOTE:
      // mobileNav={false} is NOT this: it only removes the drawer while the
      // default md(768px) breakpoint still hides the SideNav, leaving no
      // navigation at all in a narrow window.
      mobileNav={{ breakpoint: "none" }}
      sideNav={collapsed ? undefined : <SessionSidebar />}
    >
      <Outlet />
      <Settings />
      {collapsed && <LeadingSeat />}
    </AppShell>
  );
}
