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
  type PairedDaemon,
} from "./daemon-client";
import { loadOrCreateIdentity } from "./identity";

type DaemonState =
  | { status: "connecting" }
  | { status: "ready"; client: DaemonClient; paired: PairedDaemon }
  | { status: "unpaired" }
  | { status: "error"; error: Error };

interface DaemonClientContextValue {
  state: DaemonState;
  initialized: boolean;
  reset: () => void;
  /**
   * Run a first-time pair using a base64url-encoded `pair.offer` (the
   * payload from `sidecode pair`'s QR or the printed base64 fallback).
   * Resolves on successful handshake; subsequent reset()s will go
   * through the trusted-reconnect path automatically. Throws on
   * malformed payload, expired offer, or handshake failure.
   */
  pair: (offerB64: string) => Promise<void>;
  /**
   * Tear down the current connection, wipe the persisted PairedDaemon,
   * and flip to `unpaired`. The root layout's `Stack.Protected` guard
   * picks this up and routes the user back to /pair automatically — no
   * imperative navigation needed at the call site.
   */
  unpair: () => Promise<void>;
}

const Ctx = createContext<DaemonClientContextValue | null>(null);

/**
 * Owns the app's single live daemon connection. On mount it tries the
 * trusted-reconnect path; if no PairedDaemon is on disk (or reconnect
 * fails — typically a regenerated daemon identity), it lands on the
 * `unpaired` state so the layout can route to the pair screen.
 *
 * `pair()` is the only state transition that introduces new credentials;
 * `reset()` re-runs the boot path with whatever's already persisted.
 *
 * Wrap any tree that calls `useDaemonClient()` (typically inside
 * `<QueryClientProvider>` at the layout root).
 */
export function DaemonClientProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DaemonState>({ status: "connecting" });
  // Sticky: flips to true on the first successful handshake (or first
  // unpaired determination), never flips back. Splash UX keys off this —
  // `isLoading` flickers on every reset() and would briefly re-mount the
  // splash branch, but the native splash is one-shot.
  const [initialized, setInitialized] = useState(false);
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
        if (!paired) {
          if (epoch !== epochRef.current) return;
          setState({ status: "unpaired" });
          setInitialized(true);
          return;
        }
        let client: DaemonClient;
        try {
          client = await DaemonClient.reconnect(identity, paired);
        } catch (err) {
          // Reconnect failed — most likely the daemon's identity rotated
          // (fresh `~/.sidecode/identity.ed25519`) or the address moved.
          // Clear the stale credential and fall back to unpaired so the
          // user can re-scan / re-paste a fresh offer. Surface the
          // underlying error message in console for debug; UI just shows
          // "needs pairing".
          console.warn("daemon reconnect failed, clearing pair:", err);
          await clearPairedDaemon();
          if (epoch !== epochRef.current) return;
          setState({ status: "unpaired" });
          setInitialized(true);
          return;
        }
        if (epoch !== epochRef.current) {
          // A newer connect superseded us — discard.
          client.close();
          return;
        }
        clientRef.current = client;
        setState({ status: "ready", client, paired });
        setInitialized(true);
      } catch (err) {
        if (epoch !== epochRef.current) return;
        setState({
          status: "error",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    })();
  }, []);

  // First-time pair via a freshly-scanned / pasted offer. The DaemonClient
  // call persists PairedDaemon on success, so subsequent boots skip the
  // pair screen. We bump the epoch to invalidate any in-flight connect()
  // attempt (e.g. if connect() lost the race against pair()).
  //
  // Important: we deliberately do NOT flip state to `connecting` while
  // pairing — staying in `unpaired` keeps the `Stack.Protected` guard on
  // /pair active throughout, so PairScreen stays mounted and its local
  // error state survives a failed attempt. If we transitioned to
  // `connecting` mid-pair, isUnpaired would briefly flip false, the
  // router would redirect to /, and on failure flip back to /pair —
  // unmounting PairScreen and wiping the error message we just set.
  // Busy / spinner state is owned by PairScreen locally; this context
  // only flips on outcome.
  const pair = useCallback(async (offerB64: string): Promise<void> => {
    epochRef.current += 1;
    const epoch = epochRef.current;

    try {
      const identity = await loadOrCreateIdentity();
      const offer = decodePairOffer(offerB64);
      const client = await DaemonClient.pair(identity, offer);
      if (epoch !== epochRef.current) {
        client.close();
        return;
      }
      // DaemonClient.pair persists PairedDaemon synchronously before
      // resolving, so this read always sees the freshly-written record.
      const paired = await getPairedDaemon();
      if (!paired) {
        // Defensive — shouldn't happen, but if SecureStore lied we'd rather
        // fall through to error than render `ready` with no `paired`.
        client.close();
        throw new Error("paired record missing after successful pair");
      }
      if (epoch !== epochRef.current) {
        client.close();
        return;
      }
      clientRef.current?.close();
      clientRef.current = client;
      setState({ status: "ready", client, paired });
      setInitialized(true);
    } catch (err) {
      if (epoch !== epochRef.current) return;
      // State is already `unpaired` (we never flipped it). Just rethrow
      // so PairScreen's local catch can surface the error inline.
      throw err;
    }
  }, []);

  // Explicit user-initiated unpair (settings → host → "Forget host"). Bumps
  // the epoch like connect/pair so any in-flight reconnect is dropped, then
  // closes the active client, wipes SecureStore, and flips state to
  // `unpaired`. The root Stack.Protected guard does the route switch.
  const unpair = useCallback(async (): Promise<void> => {
    epochRef.current += 1;
    clientRef.current?.close();
    clientRef.current = null;
    await clearPairedDaemon();
    setState({ status: "unpaired" });
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
    () => ({ state, initialized, reset: connect, pair, unpair }),
    [state, initialized, connect, pair, unpair],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

interface UseDaemonClientResult {
  /** Live client when handshake has completed; `null` while connecting,
   *  unpaired, or after error. */
  client: DaemonClient | null;
  /** Persisted paired-daemon record (host name / addresses / fingerprint
   *  / public key) when ready; `null` otherwise. */
  paired: PairedDaemon | null;
  /** True during any in-flight handshake (initial boot AND every reset/reconnect). */
  isLoading: boolean;
  /** True when there is no PairedDaemon on disk — the app should route
   *  to the pair screen. Distinct from `error`: this is an expected
   *  state on first launch / after a daemon identity rotation. */
  isUnpaired: boolean;
  /** Sticky: true once we've reached any settled state (ready, unpaired,
   *  or error). Use this for one-shot UX like the splash gate. */
  isInitialized: boolean;
  error: Error | null;
  /** Tear down the current connection (if any) and re-run the boot path. */
  reset: () => void;
  /** Run a first-time pair from a base64url offer string. */
  pair: (offerB64: string) => Promise<void>;
  /** Forget the paired host: close, wipe SecureStore, route to /pair. */
  unpair: () => Promise<void>;
}

export function useDaemonClient(): UseDaemonClientResult {
  const v = useContext(Ctx);
  if (!v) {
    throw new Error(
      "useDaemonClient must be used inside <DaemonClientProvider>",
    );
  }
  const { state, initialized, reset, pair, unpair } = v;
  return {
    client: state.status === "ready" ? state.client : null,
    paired: state.status === "ready" ? state.paired : null,
    isLoading: state.status === "connecting",
    isUnpaired: state.status === "unpaired",
    isInitialized: initialized,
    error: state.status === "error" ? state.error : null,
    reset,
    pair,
    unpair,
  };
}
