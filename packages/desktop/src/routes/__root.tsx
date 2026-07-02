import { createRootRoute, Outlet } from "@tanstack/react-router";
import { PierrePool } from "../components/PierrePool";

export const Route = createRootRoute({
  // PierrePool at the root: the pool is a refcounted module singleton — were
  // it mounted per-route, leaving the route would terminate the workers and
  // the next visit would cold-boot them again. Root placement initializes
  // once at app launch and every diff surface (session Diff tab, P2
  // transcript tool-call diffs) shares the warm pool.
  component: () => (
    <PierrePool>
      <Outlet />
    </PierrePool>
  ),
});
