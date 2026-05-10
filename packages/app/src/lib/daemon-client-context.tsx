import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
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

// Reconnect tuning — paseo's defaults (`packages/server/src/client/daemon-client.ts`).
// Curve: 1.5s, 3s, 6s, 12s, 24s, 30s, 30s, ... (capped). No max attempts —
// retry forever; user can manually unpair if it never recovers.
const RECONNECT_BASE_DELAY_MS = 1500;
const RECONNECT_MAX_DELAY_MS = 30_000;
const reconnectDelayMs = (attempt: number): number =>
  Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);

/**
 * Internal state machine. Wider than what most consumers see — derive a
 * 4-tone `connectionStatus` for UI in `useDaemonClient` below.
 *
 * `connecting.attempt` and `offline.attempt` track the position in the
 * exponential-backoff sequence. `attempt === 0` means "first try since
 * pair / reset / mount". On a successful connect the counter resets so
 * that a brief drop heals quickly with a 1.5s retry, not a 30s one.
 */
type DaemonState =
  | { status: "connecting"; attempt: number }
  | { status: "ready"; client: DaemonClient }
  | { status: "offline"; reason?: string; attempt: number }
  | { status: "unpaired" }
  | { status: "error"; error: Error };

/**
 * Public 4-tone status for UI badges. Maps to paseo's
 * `HostRuntimeConnectionStatus` (minus `idle`, since sidecode collapses
 * pre-pair into a separate `unpaired` flag). `null` when in `unpaired`
 * state — there's nothing to show until the user pairs.
 *
 * Tone convention (matches paseo, see `packages/app/src/utils/daemons.ts`):
 *   online      → success (green)
 *   connecting  → warning (amber) — actively trying
 *   offline     → warning (amber) — waiting for next backoff slot
 *   error       → destructive (red) — terminal handshake failure
 */
export type ConnectionStatus = "connecting" | "online" | "offline" | "error";

function deriveConnectionStatus(state: DaemonState): ConnectionStatus | null {
  switch (state.status) {
    case "connecting":
      return "connecting";
    case "ready":
      return "online";
    case "offline":
      return "offline";
    case "error":
      return "error";
    case "unpaired":
      return null;
  }
}

/**
 * iOS systemColor hex for the status dot. UX choice (vs paseo's 4-tone):
 * we collapse `connecting` and `offline` to the same gray since the
 * brief amber flicker between an offline drop and the next handshake is
 * too short to be useful (~200ms in happy path), and a clear binary
 * "online vs not" is easier for users to scan. Internal state machine
 * still distinguishes the two for retry timing.
 */
export function statusColor(status: ConnectionStatus | null): string {
  switch (status) {
    case "online":
      return "#34C759"; // systemGreen
    case "connecting":
    case "offline":
      return "#8E8E93"; // systemGray — not online, retry loop owns the recovery
    case "error":
      return "#FF3B30"; // systemRed — terminal handshake failure
    case null:
      return "#8E8E93"; // page should be unmounted while unpaired, defensive
  }
}

/** Human-readable label paired with `statusColor`. */
export function statusLabel(status: ConnectionStatus | null): string {
  switch (status) {
    case "online":
      return "Online";
    case "connecting":
    case "offline":
      return "Offline";
    case "error":
      return "Error";
    case null:
      return "—";
  }
}

interface DaemonClientContextValue {
  state: DaemonState;
  paired: PairedDaemon | null;
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
 * trusted-reconnect path; if no PairedDaemon is on disk, it lands on
 * `unpaired` so the layout can route to the pair screen.
 *
 * Auto-reconnect: once the FIRST successful connection has happened (or
 * a `pair()` resolved), subsequent transport-level closes trigger an
 * exponential-backoff retry loop instead of giving up. The first connect
 * itself does NOT retry — if the daemon's identity rotated between app
 * launches the existing `clearPairedDaemon()` path sends the user back
 * to /pair (unchanged behavior). The line is `everConnectedRef`.
 *
 * `pair()` introduces new credentials. `reset()` re-runs the boot path
 * with whatever's already persisted. `unpair()` is the explicit user
 * teardown.
 *
 * Wrap any tree that calls `useDaemonClient()` (typically inside
 * `<QueryClientProvider>` at the layout root).
 */
export function DaemonClientProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DaemonState>({
    status: "connecting",
    attempt: 0,
  });
  // Sticky: flips to true on the first reach of any settled state, never
  // flips back. Splash UX keys off this — `isLoading` flickers on every
  // reset/reconnect and would otherwise re-mount the splash branch.
  const [initialized, setInitialized] = useState(false);
  // The persisted `PairedDaemon` record — orthogonal to connection state.
  // Set when a successful `pair()` writes credentials, or when boot
  // `getPairedDaemon()` finds them. Cleared only by `unpair()` or the
  // initial-boot identity-rotation fallback. Stays populated through
  // `offline` / reconnect-loop windows so settings UI keeps showing
  // hostname / fingerprint / addresses while the WS is dropped.
  const [paired, setPaired] = useState<PairedDaemon | null>(null);
  // Bumped on every (re)connect / pair / unpair. In-flight async work
  // detects supersession by comparing its captured epoch to the current
  // value; mismatch = bail out without touching state.
  const epochRef = useRef(0);
  const clientRef = useRef<DaemonClient | null>(null);
  // Pending reconnect schedule. Cleared on user-initiated transitions
  // (reset / pair / unpair) and on provider unmount.
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Auto-reconnect master switch. `false` while disposing (unmount /
  // unpair) so a late-firing onUnexpectedClose / timer doesn't resurrect
  // a doomed connection. Re-armed by `connect()` and `pair()`.
  const shouldReconnectRef = useRef(true);
  // Once `true`, transient reconnect failures retry instead of clearing
  // the paired record. Flipped on the first successful handshake (whether
  // via boot reconnect or `pair()`); reset on `unpair()`. Distinguishes
  // "daemon identity rotated since last launch — boot to /pair" from
  // "we know this daemon, just keep trying".
  const everConnectedRef = useRef(false);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /**
   * Auto-reconnect entrypoint. Defined as a `useEffectEvent` so the
   * stable-identity closure can directly reference `connect` (declared
   * later in this scope) without forming a `useCallback` dependency
   * cycle, AND without going through a manual ref. React guarantees the
   * function always uses the latest closure when called.
   *
   * Constraint: only safe to call from async event sources (network
   * close, setTimeout) — NOT during render. We call it from a WS close
   * handler and from a timer callback, both of which qualify.
   *
   * The `epoch` argument is captured per fresh client so a late-firing
   * close (e.g. WS dies milliseconds after `unpair()` bumped the epoch)
   * is dropped instead of triggering a ghost reconnect. First retry
   * uses `attempt: 1` since this branch is only reached after at least
   * one successful connection.
   */
  const handleUnexpectedClose = useEffectEvent((epoch: number) => {
    if (epoch !== epochRef.current) return;
    if (!shouldReconnectRef.current) return;
    clearReconnectTimer();
    setState({ status: "offline", attempt: 0 });
    const delay = reconnectDelayMs(0);
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (epoch !== epochRef.current) return;
      if (!shouldReconnectRef.current) return;
      connect(1);
    }, delay);
  });

  /**
   * Boot-retry entrypoint — called when the initial handshake (or a
   * subsequent retry of it) fails. Same useEffectEvent rationale as
   * `handleUnexpectedClose`: avoids the dep cycle with `connect`.
   */
  const handleBootRetry = useEffectEvent((epoch: number, attempt: number) => {
    reconnectTimerRef.current = null;
    if (epoch !== epochRef.current) return;
    if (!shouldReconnectRef.current) return;
    connect(attempt + 1);
  });

  const connect = useCallback(
    (attempt: number = 0) => {
      epochRef.current += 1;
      const epoch = epochRef.current;

      clearReconnectTimer();
      clientRef.current?.close();
      clientRef.current = null;
      shouldReconnectRef.current = true;
      setState({ status: "connecting", attempt });

      void (async () => {
        try {
          const identity = await loadOrCreateIdentity();
          const loaded = await getPairedDaemon();
          if (!loaded) {
            if (epoch !== epochRef.current) return;
            setPaired(null);
            setState({ status: "unpaired" });
            setInitialized(true);
            return;
          }
          // Publish loaded paired record IMMEDIATELY — settings UI relies
          // on this to keep showing hostname / fingerprint / addresses
          // through the connecting + offline window. Decoupled from the
          // connection state machine.
          setPaired(loaded);
          let client: DaemonClient;
          try {
            client = await DaemonClient.reconnect(identity, loaded);
          } catch (err) {
            if (epoch !== epochRef.current) return;
            if (everConnectedRef.current && shouldReconnectRef.current) {
              // We've successfully reached this daemon at least once
              // since pair / unpair, so a failure here is most likely
              // transient (network blip, daemon momentarily down).
              // Schedule a retry instead of nuking the paired record.
              const reason = err instanceof Error ? err.message : String(err);
              setState({ status: "offline", reason, attempt });
              const delay = reconnectDelayMs(attempt);
              reconnectTimerRef.current = setTimeout(
                () => handleBootRetry(epoch, attempt),
                delay,
              );
              setInitialized(true);
              return;
            }
            // First-launch boot failure: most likely the daemon's
            // identity rotated (fresh `~/.sidecode/identity.ed25519`)
            // or the address moved permanently. Clear the stale
            // credential and fall through to /pair.
            console.warn(
              "daemon initial reconnect failed, clearing pair:",
              err,
            );
            await clearPairedDaemon();
            setPaired(null);
            setState({ status: "unpaired" });
            setInitialized(true);
            return;
          }
          if (epoch !== epochRef.current) {
            client.close();
            return;
          }
          client.setOnUnexpectedClose(() => handleUnexpectedClose(epoch));
          everConnectedRef.current = true;
          clientRef.current = client;
          setState({ status: "ready", client });
          setInitialized(true);
        } catch (err) {
          if (epoch !== epochRef.current) return;
          setState({
            status: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          });
          setInitialized(true);
        }
      })();
    },
    // handleBootRetry / handleUnexpectedClose are useEffectEvent —
    // stable-identity by contract, intentionally excluded from deps.
    [clearReconnectTimer],
  );

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
  const pair = useCallback(
    async (offerB64: string): Promise<void> => {
      epochRef.current += 1;
      const epoch = epochRef.current;
      clearReconnectTimer();
      shouldReconnectRef.current = true;

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
        const loaded = await getPairedDaemon();
        if (!loaded) {
          // Defensive — shouldn't happen, but if SecureStore lied we'd
          // rather fall through to error than render `ready` with no
          // `paired`.
          client.close();
          throw new Error("paired record missing after successful pair");
        }
        if (epoch !== epochRef.current) {
          client.close();
          return;
        }
        clientRef.current?.close();
        client.setOnUnexpectedClose(() => handleUnexpectedClose(epoch));
        everConnectedRef.current = true;
        clientRef.current = client;
        setPaired(loaded);
        setState({ status: "ready", client });
        setInitialized(true);
      } catch (err) {
        if (epoch !== epochRef.current) return;
        // State is already `unpaired` (we never flipped it). Just rethrow
        // so PairScreen's local catch can surface the error inline.
        throw err;
      }
    },
    // handleUnexpectedClose is useEffectEvent — see note in `connect`.
    [clearReconnectTimer],
  );

  // Explicit user-initiated unpair (settings → host → "Forget host").
  // Bumps the epoch like connect/pair so any in-flight reconnect is
  // dropped, then closes the active client, wipes SecureStore, and flips
  // state to `unpaired`. The root Stack.Protected guard does the route
  // switch. Sets shouldReconnectRef to false so a late-firing
  // onUnexpectedClose / backoff-timer-fire doesn't resurrect anything.
  const unpair = useCallback(async (): Promise<void> => {
    epochRef.current += 1;
    shouldReconnectRef.current = false;
    everConnectedRef.current = false;
    clearReconnectTimer();
    clientRef.current?.close();
    clientRef.current = null;
    await clearPairedDaemon();
    setPaired(null);
    setState({ status: "unpaired" });
  }, [clearReconnectTimer]);

  useEffect(() => {
    connect();
    return () => {
      epochRef.current += 1;
      shouldReconnectRef.current = false;
      clearReconnectTimer();
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, [connect, clearReconnectTimer]);

  const reset = useCallback(() => connect(0), [connect]);

  const value = useMemo<DaemonClientContextValue>(
    () => ({ state, paired, initialized, reset, pair, unpair }),
    [state, paired, initialized, reset, pair, unpair],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

interface UseDaemonClientResult {
  /** Live client when handshake has completed; `null` while connecting,
   *  unpaired, after error, or while waiting for a reconnect retry. */
  client: DaemonClient | null;
  /**
   * Persisted paired-daemon record (host name / addresses / fingerprint
   *  / public key). Available throughout `ready` AND `offline` AND
   *  reconnect-loop windows — only `null` when there's no record on disk
   *  (initial unpaired, or after an explicit `unpair()` / first-boot
   *  identity-rotation fallback). Settings UI relies on this to keep
   *  showing host info when the WS is dropped.
   */
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
  /**
   * 4-tone status for UI badges (connecting / online / offline / error).
   * `null` when there's nothing to show (`unpaired` — pair screen is
   * already up). See ConnectionStatus type for tone mapping.
   */
  connectionStatus: ConnectionStatus | null;
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
  const { state, paired, initialized, reset, pair, unpair } = v;
  return {
    client: state.status === "ready" ? state.client : null,
    paired,
    isLoading: state.status === "connecting",
    isUnpaired: state.status === "unpaired",
    isInitialized: initialized,
    error: state.status === "error" ? state.error : null,
    connectionStatus: deriveConnectionStatus(state),
    reset,
    pair,
    unpair,
  };
}
