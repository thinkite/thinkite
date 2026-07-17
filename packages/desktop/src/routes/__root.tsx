import { AppShell } from "@astryxdesign/core/AppShell";
import {
  createRootRoute,
  Outlet,
  useRouterState,
} from "@tanstack/react-router";
import type { CSSProperties } from "react";
import { PierrePool } from "../components/PierrePool";
import { SessionSidebar } from "../components/SessionSidebar";

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

// Electron hiddenInset: the window has a TRANSPARENT titlebar — render a
// drag strip and push the app below the traffic lights. Chromium's native
// `-webkit-app-region: drag` CSS replaces the electrobun-era class-based
// preload polyfill, and it preventDefaults properly so no select-none dance.
// In a plain browser (vite dev tab) the UA flag is absent and this renders
// nothing.
const isDesktopShell =
  typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");
const DRAG_REGION = { WebkitAppRegion: "drag" } as CSSProperties;

function RootLayout() {
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  if (BARE_ROUTES.has(pathname)) {
    return <Outlet />;
  }
  if (isDesktopShell) {
    return (
      <PierrePool>
        <div className="flex h-dvh flex-col">
          <div className="h-7 shrink-0 cursor-default" style={DRAG_REGION} />
          <div className="min-h-0 flex-1">
            {/* height="fill" compiles to 100dvh — viewport-fixed, which
                would overflow by the strip's 28px and grow a window
                scrollbar. Inline style outranks the stylex atom; the PROP
                stays "fill" so the shell's internal isScrollable panes
                keep working. */}
            <RootChrome style={{ height: "100%" }} />
          </div>
        </div>
      </PierrePool>
    );
  }
  return (
    <PierrePool>
      <RootChrome />
    </PierrePool>
  );
}

function RootChrome({ style }: { style?: CSSProperties }) {
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
      sideNav={<SessionSidebar />}
    >
      <Outlet />
    </AppShell>
  );
}
