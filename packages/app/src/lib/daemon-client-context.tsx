import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clearPairedDaemon,
  DaemonClient,
  decodePairOffer,
  getPairedDaemon,
} from "./daemon-client";
import { loadOrCreateIdentity } from "./identity";
import { DEV_PAIR_OFFER } from "./pair-config";

type DaemonState =
  | { status: "connecting" }
  | { status: "ready"; client: DaemonClient }
  | { status: "error"; error: Error };

interface DaemonClientContextValue {
  state: DaemonState;
  reset: () => void;
}

const Ctx = createContext<DaemonClientContextValue | null>(null);

/**
 * Owns the app's single live daemon connection. Handshake fires eagerly
 * on Provider mount (i.e. app boot) — the only screen consumer is the
 * session list, so deferring would just delay the same work.
 *
 * Wrap any tree that calls `useDaemonClient()` (typically inside
 * `<QueryClientProvider>` at the layout root).
 */
export function DaemonClientProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DaemonState>({ status: "connecting" });
  // Bumped on every connect() call; in-flight handshakes that finish after
  // a newer connect started are dropped via this guard.
  const epochRef = useRef(0);
  const clientRef = useRef<DaemonClient | null>(null);

  const connect = useCallback(() => {
    epochRef.current += 1;
    const epoch = epochRef.current;

    clientRef.current?.close();
    clientRef.current = null;
    setState({ status: "connecting" });

    void (async () => {
      try {
        const identity = await loadOrCreateIdentity();
        const paired = await getPairedDaemon();
        let client: DaemonClient;
        if (paired) {
          try {
            client = await DaemonClient.reconnect(identity, paired);
          } catch (err) {
            await clearPairedDaemon();
            if (!DEV_PAIR_OFFER) throw err;
            client = await DaemonClient.pair(
              identity,
              decodePairOffer(DEV_PAIR_OFFER),
            );
          }
        } else {
          if (!DEV_PAIR_OFFER) {
            throw new Error(
              "No paired daemon. Paste a pair.offer into pair-config.ts (DEV_PAIR_OFFER).",
            );
          }
          client = await DaemonClient.pair(
            identity,
            decodePairOffer(DEV_PAIR_OFFER),
          );
        }
        if (epoch !== epochRef.current) {
          // A newer connect superseded us — discard.
          client.close();
          return;
        }
        clientRef.current = client;
        setState({ status: "ready", client });
      } catch (err) {
        if (epoch !== epochRef.current) return;
        setState({
          status: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })();
  }, []);

  useEffect(() => {
    connect();
    return () => {
      epochRef.current += 1; // invalidate any in-flight handshake
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [connect]);

  const value = useMemo<DaemonClientContextValue>(
    () => ({ state, reset: connect }),
    [state, connect],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

interface UseDaemonClientResult {
  /** Live client when handshake has completed; `null` while connecting or after error. */
  client: DaemonClient | null;
  isLoading: boolean;
  error: Error | null;
  /** Tear down the current connection (if any) and re-run the handshake. */
  reset: () => void;
}

export function useDaemonClient(): UseDaemonClientResult {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error(
      "useDaemonClient must be used inside <DaemonClientProvider>",
    );
  }
  const { state, reset } = v;
  return {
    client: state.status === "ready" ? state.client : null,
    isLoading: state.status === "connecting",
    error: state.status === "error" ? state.error : null,
    reset,
  };
}
