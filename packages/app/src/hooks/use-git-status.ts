import type { GitStatus } from "@sidecodeapp/protocol";
import { useEffect, useState } from "react";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Subscribe to live git status for a `cwd`. Returns the latest snapshot
 * or `null` while loading / when client isn't ready / cwd is undefined.
 *
 * Race / cleanup mirrors `useLiveSession`:
 *   - `active` guards against setState after unmount.
 *   - If the subscribe Promise resolves after unmount, we still call
 *     the returned `unsubscribe` thunk so the daemon stops fanning
 *     events to a callback whose owner is gone.
 *   - DaemonClient's `subscribeGitStatus` is identity-checked: a stale
 *     unsubscribe after a quick remount won't clobber the new sub.
 *
 * Returns `null` when there's no usable state to render. Caller (the
 * info bar) decides whether to hide entirely or show a placeholder.
 */
export function useGitStatus(cwd: string | undefined): GitStatus | null {
  const { client } = useDaemonClient();
  const [status, setStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
    if (!client || !cwd) {
      setStatus(null);
      return;
    }
    let active = true;
    let cleanup: (() => Promise<void>) | null = null;

    // Reset on cwd change so we don't briefly show the prior cwd's
    // numbers while waiting for the new subscribe to resolve.
    setStatus(null);

    client
      .subscribeGitStatus(cwd, (s) => {
        if (!active) return;
        setStatus(s);
      })
      .then(({ status: initial, unsubscribe }) => {
        if (!active) {
          void unsubscribe();
          return;
        }
        setStatus(initial);
        cleanup = unsubscribe;
      })
      .catch((err) => {
        if (!active) return;
        console.error("subscribeGitStatus failed", err);
      });

    return () => {
      active = false;
      void cleanup?.();
    };
  }, [client, cwd]);

  return status;
}
