import { useEffect } from "react";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Watch a directory's servers while the screen shows it. The phone has no
 * server list yet; the watch is what makes the daemon serve its tools
 * (`server_start` and the rest) to sessions in the directory, and opencode
 * fixes a turn's tools when the turn starts, so it has to be up before the
 * user sends (docs/preview-tool-v1.md). Re-subscribes after a reconnect,
 * like `useGitStatus`.
 */
export function useWatchServers(directory: string | undefined): void {
  const { client, connectionStatus } = useDaemonClient();
  const online = connectionStatus === "online";

  useEffect(() => {
    if (!online || directory === undefined) return;
    let active = true;
    let unsub: (() => Promise<void>) | null = null;
    client
      .subscribePreviews(directory, () => undefined)
      .then(({ unsubscribe }) => {
        if (!active) return void unsubscribe().catch(() => {});
        unsub = unsubscribe;
      })
      .catch((err) => {
        if (active) console.warn("subscribePreviews failed", err);
      });
    return () => {
      active = false;
      void unsub?.().catch(() => {});
    };
  }, [client, directory, online]);
}
