import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";
import {
  clearPairedDaemon,
  DaemonClient,
  decodePairOffer,
  getPairedDaemon,
} from "./daemon-client";
import { loadOrCreateIdentity } from "./identity";
import { DEV_PAIR_OFFER } from "./pair-config";

interface DaemonClientContextValue {
  /** Lazily connect (handshake on first call) and return the live client.
   *  Subsequent calls reuse the same instance. If the underlying connection
   *  drops, the next call re-handshakes. */
  get(): Promise<DaemonClient>;
  /** Force a fresh connection on next `get()`. Used by error recovery
   *  paths (e.g. "re-pair" UI in V0.5+). */
  reset(): void;
}

const Ctx = createContext<DaemonClientContextValue | null>(null);

/**
 * Owns the app's single live daemon connection. Provider must wrap any tree
 * that calls `useDaemonClient()` (typically the whole app, inside
 * `<QueryClientProvider>`).
 */
export function DaemonClientProvider({ children }: { children: ReactNode }) {
  const cacheRef = useRef<Promise<DaemonClient> | null>(null);

  const get = (): Promise<DaemonClient> => {
    if (cacheRef.current) return cacheRef.current;
    const promise = (async () => {
      const identity = await loadOrCreateIdentity();
      const paired = await getPairedDaemon();
      if (paired) {
        try {
          return await DaemonClient.reconnect(identity, paired);
        } catch (err) {
          await clearPairedDaemon();
          if (!DEV_PAIR_OFFER) throw err;
          return DaemonClient.pair(identity, decodePairOffer(DEV_PAIR_OFFER));
        }
      }
      if (!DEV_PAIR_OFFER) {
        throw new Error(
          "No paired daemon. Paste a pair.offer into pair-config.ts (DEV_PAIR_OFFER).",
        );
      }
      return DaemonClient.pair(identity, decodePairOffer(DEV_PAIR_OFFER));
    })();
    promise.catch(() => {
      // Drop on failure so the next get() re-handshakes.
      if (cacheRef.current === promise) cacheRef.current = null;
    });
    cacheRef.current = promise;
    return promise;
  };

  const reset = () => {
    const stale = cacheRef.current;
    cacheRef.current = null;
    stale?.then((c) => c.close()).catch(() => undefined);
  };

  // Tear down on unmount (Provider remounts during HMR; clean exit avoids
  // dangling sockets).
  useEffect(() => () => reset(), []);

  return <Ctx.Provider value={{ get, reset }}>{children}</Ctx.Provider>;
}

export function useDaemonClient(): DaemonClientContextValue {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error("useDaemonClient must be used inside <DaemonClientProvider>");
  }
  return v;
}
