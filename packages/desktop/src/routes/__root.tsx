import { createRootRoute, Outlet } from "@tanstack/react-router";
import { AppShell } from "@astryxdesign/core/AppShell";
import { PierrePool } from "../components/PierrePool";
import { SessionSidebar } from "../components/SessionSidebar";

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
  component: () => (
    <PierrePool>
      <AppShell
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
    </PierrePool>
  ),
});
