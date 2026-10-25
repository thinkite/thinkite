import { type ForwardPort, IROH_TCP_ALPN } from "@thinkite/protocol";
import { useEffect, useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { EndpointAddr, EndpointId } from "react-native-iroh-ffi";
import {
  forwardTcp,
  type TcpForwarderLike,
} from "react-native-iroh-ffi/extras";
import { base64UrlToBytes } from "./base64";
import { useDaemonClient } from "./daemon-client-context";
import { loadOrCreateIdentity } from "./identity";
import { getEndpoint } from "./iroh-wire";

// The Mac's dev servers on the phone's own localhost (docs/preview-tool-v1.md,
// "Phone"). While the app is in the foreground, every port of every server
// the agent started (the daemon's forward-port list) gets a listener on
// 127.0.0.1:<same port>, tunnelled over thinkite/tcp/1 to that port on the
// Mac: a page's origin stays `localhost:<port>`, and it reaches its API on
// another port the same way. The listeners ride the app's one iroh
// endpoint (iroh-wire's getEndpoint).
//
// iOS may reclaim a suspended app's listening sockets (TN2277, notably on
// screen lock), so they all close when the app goes to the background and
// listen again when it comes back: about 0.4 s after a 6 min lock in the
// forward-tcp spike.

export interface ForwardState {
  /** The daemon's list, as last heard (kept while in the background). */
  ports: readonly ForwardPort[];
  /** Ports with a listener up now. */
  listening: ReadonlySet<number>;
  /** Ports whose listener could not start, and why (a port taken on the
   *  phone: no other number is tried, the page's origin must stay). */
  failed: ReadonlyMap<number, string>;
}

let state: ForwardState = {
  ports: [],
  listening: new Set(),
  failed: new Map(),
};
const listeners = new Set<() => void>();

function set(next: Partial<ForwardState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** The forwarding state now, for code outside React (opening a link). */
export function forwardState(): ForwardState {
  return state;
}

export function useForwardState(): ForwardState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}

const toBuf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

const ALPN = toBuf(Uint8Array.from(IROH_TCP_ALPN, (c) => c.charCodeAt(0)));

/**
 * Headless: keeps the listeners in step with the daemon's forward-port
 * list while the app is in the foreground and the daemon is online.
 * Mounted once, inside the DaemonClientProvider.
 */
export function PortForwarder(): null {
  const { client, connectionStatus, paired } = useDaemonClient();
  const daemonKey = paired?.daemonIdentityPublicKey;
  const online = connectionStatus === "online" && daemonKey !== undefined;

  useEffect(() => {
    if (!online || daemonKey === undefined) return;
    let alive = true;
    let foreground = AppState.currentState !== "background";
    let wanted: readonly ForwardPort[] = state.ports;
    const open = new Map<number, TcpForwarderLike>();
    // One reconcile at a time, so a quick background→active never leaves
    // two listeners on a port.
    let chain: Promise<void> = Promise.resolve();
    let unsubscribe: (() => Promise<void>) | null = null;

    const reconcile = () => {
      chain = chain.then(async () => {
        const target = new Set(
          alive && foreground ? wanted.map((p) => p.port) : [],
        );
        for (const [port, fw] of open) {
          if (target.has(port)) continue;
          open.delete(port);
          await fw.close().catch(() => undefined);
        }
        const failed = new Map(state.failed);
        for (const port of failed.keys())
          if (!target.has(port)) failed.delete(port);
        const toOpen = [...target].filter((p) => !open.has(p));
        if (toOpen.length > 0) {
          const endpoint = await getEndpoint(await loadOrCreateIdentity());
          const remote = new EndpointAddr(
            EndpointId.fromBytes(toBuf(base64UrlToBytes(daemonKey))),
            undefined,
            [],
          );
          for (const port of toOpen) {
            try {
              open.set(
                port,
                await forwardTcp(endpoint, {
                  localPort: port,
                  remote,
                  alpn: ALPN,
                  header: toBuf(Uint8Array.of(port >> 8, port & 0xff)),
                  onError: (e) =>
                    console.warn(`[forward] ${port}: ${e.message()}`),
                }),
              );
              failed.delete(port);
            } catch (e) {
              failed.set(port, e instanceof Error ? e.message : String(e));
            }
          }
        }
        set({ listening: new Set(open.keys()), failed });
      });
    };

    // The list comes from the daemon only while in the foreground: the
    // subscription is also what keeps the daemon looking up ports.
    const follow = async () => {
      if (!alive || !foreground || unsubscribe !== null) return;
      try {
        const sub = await client.subscribeForwardPorts((ports) => {
          wanted = ports;
          set({ ports });
          reconcile();
        });
        if (!alive || !foreground) {
          void sub.unsubscribe().catch(() => undefined);
          return;
        }
        unsubscribe = sub.unsubscribe;
        wanted = await client.getForwardPorts();
        set({ ports: wanted });
      } catch (e) {
        console.warn("[forward] subscribe failed", e);
      }
      reconcile();
    };
    const unfollow = () => {
      const u = unsubscribe;
      unsubscribe = null;
      void u?.().catch(() => undefined);
    };

    const sub = AppState.addEventListener("change", (s: AppStateStatus) => {
      if (s === "background" && foreground) {
        foreground = false;
        unfollow();
        reconcile();
      } else if (s === "active" && !foreground) {
        foreground = true;
        void follow();
      }
    });
    void follow();

    return () => {
      alive = false;
      sub.remove();
      unfollow();
      reconcile();
    };
  }, [client, online, daemonKey]);

  return null;
}
