import type { GitStatus } from "@sidecodeapp/protocol";
import { useEffect, useRef, useState } from "react";
import { useDaemonClient } from "@/lib/daemon-client-context";

/**
 * Subscribe to live git status for a `cwd`. Returns the latest snapshot
 * or `null` while loading / cwd is undefined.
 *
 * Why `connectionStatus` is in useEffect deps: unlike the transcript
 * subscribe (which goes through the facade's auto-resume Subscription
 * registry), git status is a pass-through to the current Transport.
 * When the transport drops + reconnects the old subscription is dead;
 * the facade's stable `client` reference alone wouldn't trigger a
 * re-subscribe. Including `connectionStatus` makes the effect re-fire
 * on every offline→online transition, landing a fresh subscribe on the
 * new transport. Git watcher updates are cheap so the extra round-trip
 * is fine — auto-resume in the facade is the wrong tool for this case.
 *
 * Race / cleanup:
 *   - `active` guards against setState after unmount.
 *   - If the subscribe Promise resolves after unmount, we still call
 *     the returned `unsubscribe` thunk (best-effort — transport may
 *     already be dead).
 *   - Transport's `subscribeGitStatus` is identity-checked: a stale
 *     unsubscribe after a quick remount won't clobber the new sub.
 *
 * Returns `null` when there's no usable state to render. Caller (the
 * info bar) decides whether to hide entirely or show a placeholder.
 */
export function useGitStatus(
  cwd: string | undefined,
  /** Fired on every status push (incl. the initial snapshot) while mounted — a
   *  generic change hook so the caller can react (e.g. invalidate a derived
   *  query) WITHOUT this primitive knowing about that query. Held in a ref, so
   *  passing a fresh inline callback each render doesn't re-subscribe. */
  onChange?: (status: GitStatus) => void,
): GitStatus | null {
  const { client, connectionStatus } = useDaemonClient();
  const [status, setStatus] = useState<GitStatus | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!cwd || connectionStatus !== "online") {
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
        onChangeRef.current?.(s);
      })
      .then(({ status: initial, unsubscribe }) => {
        if (!active) {
          void unsubscribe().catch(() => {});
          return;
        }
        setStatus(initial);
        onChangeRef.current?.(initial);
        cleanup = unsubscribe;
      })
      .catch((err) => {
        if (!active) return;
        console.error("subscribeGitStatus failed", err);
      });

    return () => {
      active = false;
      void cleanup?.().catch(() => {});
    };
  }, [client, cwd, connectionStatus]);

  return status;
}
