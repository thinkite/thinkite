import { useEffect } from "react";
import { queryClient, vcsKeys } from "./query";

// The repository reads (vcsKeys) follow the folder's changes as the daemon's
// git watcher sees them (/api/git/events): the agent's edits mid-turn, and a
// reset, stash or branch switch outside the app, which opencode reports no
// event for. Each push reads every query of the folder again.

const SETTLE_MS = 200;

export function useGitEvents(directory: string | null | undefined): void {
  useEffect(() => {
    if (!directory) return;
    const source = new EventSource(
      `/api/git/events?directory=${encodeURIComponent(directory)}`,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    source.onmessage = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () =>
          void queryClient.invalidateQueries({
            queryKey: vcsKeys.all(directory),
          }),
        SETTLE_MS,
      );
    };
    return () => {
      clearTimeout(timer);
      source.close();
    };
  }, [directory]);
}
