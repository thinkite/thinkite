import {
  type Connection,
  type ConnectionContext,
  type Lobby,
  routePartykitRequest,
  Server,
  type WSMessage,
} from "partyserver";

/**
 * sidecode WebRTC signaling server.
 *
 * Each daemon Ed25519 pubkey gets its own Durable Object instance (the
 * room name = daemon pubkey). Mac daemon and paired iOS clients both
 * connect; the DO shuffles SDP offers/answers + ICE candidates by an
 * explicit `to` field so iPhone + iPad can both signal the same daemon
 * concurrently. After ICE completes, app traffic flows P2P over WebRTC
 * DataChannel — the DO hibernates until the next signaling event.
 *
 * Trust model:
 *  - Room name = daemon pubkey (out-of-band trust root, from QR scan).
 *  - Daemon must prove pubkey ownership via Ed25519 signature on
 *    `signaling/v1/<pubkey>/<ts>` to claim role=daemon for that room.
 *  - Clients self-declare a pubkey but DO does NOT verify. The daemon
 *    decides whether to accept the iOS pubkey against its own
 *    known_clients list (application-layer gate).
 *  - DO never sees DataChannel content — DTLS encrypts P2P traffic.
 *
 * Hibernation: `static options = { hibernate: true }`. DO sleeps when
 * no message is flowing; CF edge keeps WebSockets alive on its behalf.
 * Keeps free-tier cost near zero for V0 portfolio scale.
 */

// `from` is server-injected on forward; clients can't spoof.
type Role = "daemon" | "client";

interface ConnectionState {
  role: Role;
  pubkey: string;
}

interface PeerDescriptor {
  id: string;
  pubkey: string;
  role: Role;
}

/** Wire envelope DO accepts. `from` is filled in by server on forward. */
interface ClientEnvelope {
  to: string;
  type: string;
  // payload fields are protocol-defined (offer/answer/candidate/etc.),
  // forwarded transparently.
  [key: string]: unknown;
}

/** Maximum allowed clock skew when verifying daemon signature timestamps. */
const MAX_TS_SKEW_MS = 60_000;

/** Maximum payload size we'll forward — guards against accidental floods. */
const MAX_MSG_BYTES = 64 * 1024;

export class Signaling extends Server<Env> {
  /**
   * Hibernation is the core of the cost model. Without it the DO stays
   * resident as long as WebSockets are open, racking up GB-seconds for
   * idle connections.
   */
  static options = { hibernate: true };

  /**
   * Tags survive hibernation (PartyServer persists them via attachment).
   * We use them to filter `getConnections("daemon")` / `getConnections("client")`
   * without rehydrating per-connection state on every wake.
   */
  getConnectionTags(_connection: Connection, ctx: ConnectionContext): string[] {
    const url = new URL(ctx.request.url);
    const role = url.searchParams.get("role");
    return role === "daemon" ? ["daemon"] : ["client"];
  }

  /**
   * Validation (role / signature / timestamp) lives in `authenticate()`
   * down below and runs via `onBeforeConnect` — pre-upgrade, so rejected
   * connections never reach this DO. By the time `onConnect` fires the
   * connection is already known-good; we only do bookkeeping.
   */
  async onConnect(connection: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const role = url.searchParams.get("role") as Role;
    const roomPubkey = this.name; // PartyServer maps room URL → DO name

    if (role === "daemon") {
      // Replace any previously-connected daemon for this room — daemon
      // restarts shouldn't leave zombie sockets routing messages into
      // the void.
      for (const c of this.getConnections("daemon")) {
        if (c.id !== connection.id) c.close(1008, "replaced_by_new_daemon");
      }

      connection.setState({
        role: "daemon",
        pubkey: roomPubkey,
      } satisfies ConnectionState);

      // Hand the daemon a roster of currently-online clients so it knows
      // who to issue offers to. (Most common at daemon restart: clients
      // were here first.)
      const peers: PeerDescriptor[] = [];
      for (const c of this.getConnections("client")) {
        const s = c.state as ConnectionState | null;
        if (s) peers.push({ id: c.id, pubkey: s.pubkey, role: "client" });
      }
      connection.send(JSON.stringify({ type: "peers", peers }));
      return;
    }

    // role === "client"
    const clientPubkey = url.searchParams.get("pubkey") ?? "";
    connection.setState({
      role: "client",
      pubkey: clientPubkey,
    } satisfies ConnectionState);

    // Notify all online daemons (typically just one) of the new client.
    // The daemon will gate against its known_clients.json at application
    // layer before deciding to issue an offer.
    const joinedFrame = JSON.stringify({
      type: "peer.joined",
      peer: {
        id: connection.id,
        pubkey: clientPubkey,
        role: "client",
      } satisfies PeerDescriptor,
    });
    for (const d of this.getConnections("daemon")) {
      d.send(joinedFrame);
    }

    // And give the client the current daemon (if online) — useful to
    // know whether to wait or surface "Mac offline" to the user.
    const daemons: PeerDescriptor[] = [];
    for (const c of this.getConnections("daemon")) {
      daemons.push({ id: c.id, pubkey: roomPubkey, role: "daemon" });
    }
    connection.send(JSON.stringify({ type: "peers", peers: daemons }));
  }

  onMessage(sender: Connection, raw: WSMessage) {
    // Reject oversized payloads early — protects DO from accidental
    // floods (a buggy client sending megabytes of SDP attempts).
    const size =
      typeof raw === "string"
        ? raw.length
        : raw instanceof ArrayBuffer
          ? raw.byteLength
          : raw.byteLength;
    if (size > MAX_MSG_BYTES) {
      sender.send(
        JSON.stringify({ type: "error", reason: "payload_too_large" }),
      );
      return;
    }

    let parsed: ClientEnvelope;
    try {
      parsed = JSON.parse(
        typeof raw === "string" ? raw : new TextDecoder().decode(raw),
      );
    } catch {
      sender.send(JSON.stringify({ type: "error", reason: "bad_json" }));
      return;
    }

    if (typeof parsed.to !== "string" || !parsed.to) {
      sender.send(JSON.stringify({ type: "error", reason: "missing_to" }));
      return;
    }
    if (typeof parsed.type !== "string" || !parsed.type) {
      sender.send(JSON.stringify({ type: "error", reason: "missing_type" }));
      return;
    }

    const target = this.getConnection(parsed.to);
    if (!target) {
      // Common cases: target reconnected and has new id, or never
      // connected. Surface this so sender can re-discover via the next
      // `peer.joined` event.
      sender.send(
        JSON.stringify({
          type: "error",
          reason: "peer_not_found",
          to: parsed.to,
        }),
      );
      return;
    }

    // Server-stamp the `from` field. We don't trust client-supplied
    // values — otherwise an attacker who knew another peer's id could
    // impersonate them in routed messages.
    const forwarded = { ...parsed, from: sender.id };
    target.send(JSON.stringify(forwarded));
  }

  onClose(
    connection: Connection,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ) {
    const state = connection.state as ConnectionState | null;
    if (!state) return;
    const peerRole: Role = state.role === "daemon" ? "client" : "daemon";
    const frame = JSON.stringify({
      type: "peer.left",
      peer: {
        id: connection.id,
        pubkey: state.pubkey,
        role: state.role,
      } satisfies PeerDescriptor,
    });
    for (const c of this.getConnections(peerRole)) {
      c.send(frame);
    }
  }

  onError(connection: Connection, error: unknown) {
    // CF observability already records this; keep a short note for
    // local `wrangler tail` debugging. Don't propagate to peers —
    // single-side errors aren't a peer-routing event.
    console.error(
      `[Signaling/${this.name}] ws error (conn=${connection.id}):`,
      error,
    );
  }
}

/**
 * Verify an Ed25519 signature over a UTF-8 `message` against `pubkeyB64`.
 *
 * Workers' Web Crypto supports Ed25519 natively as of compatibility_date
 * 2023-08-01 — no third-party crypto lib needed. Domain-tagged messages
 * (`signaling/v1/...` vs `turn/v1/...`) keep a signature minted for one
 * purpose from being replayable as another.
 */
async function verifyEd25519(
  pubkeyB64: string,
  message: string,
  sigB64Url: string,
): Promise<boolean> {
  try {
    const pubKeyBytes = base64UrlDecode(pubkeyB64);
    if (pubKeyBytes.byteLength !== 32) return false; // Ed25519 pubkey is 32 bytes
    const sigBytes = base64UrlDecode(sigB64Url);
    if (sigBytes.byteLength !== 64) return false; // Ed25519 signature is 64 bytes

    const key = await crypto.subtle.importKey(
      "raw",
      pubKeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      sigBytes,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

/**
 * Verify a daemon's claim to own the room's Ed25519 pubkey.
 *
 * Wire format (URL query): `?role=daemon&ts=<unix-ms>&sig=<base64url>`
 * Signature covers: `signaling/v1/${roomPubkey}/${ts}`.
 */
function verifyDaemonSig(
  roomPubkey: string,
  ts: number,
  sigB64Url: string,
): Promise<boolean> {
  return verifyEd25519(
    roomPubkey,
    `signaling/v1/${roomPubkey}/${ts}`,
    sigB64Url,
  );
}

/** TURN credential TTL requested from Cloudflare (seconds). 12h gives a
 *  daemon a long-lived cred it can reuse across reconnects; the daemon
 *  re-mints before expiry. Long enough to keep mint volume low, short
 *  enough that a leaked cred self-expires within a day. */
const TURN_CRED_TTL_SECONDS = 12 * 60 * 60;

/** Ed25519 message a daemon signs to mint TURN creds. Distinct domain tag
 *  from the signaling-connect signature so the two aren't interchangeable. */
function turnSigMessage(pubkey: string, ts: number): string {
  return `turn/v1/${pubkey}/${ts}`;
}

/** One RTCIceServer entry as Cloudflare's generate-ice-servers returns. */
interface TurnIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/**
 * Mint short-lived TURN credentials from Cloudflare Realtime TURN. Returns
 * the ICE-server LIST (an ARRAY: a STUN entry + a TURN entry with ephemeral
 * username/credential) or null on any failure — caller turns null into a
 * 5xx so the daemon gracefully falls back to STUN-only. NOTE: Cloudflare
 * returns `iceServers` as an array, not a single object.
 */
async function mintTurnCredentials(
  keyId: string,
  apiToken: string,
): Promise<TurnIceServer[] | null> {
  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_CRED_TTL_SECONDS }),
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { iceServers?: TurnIceServer[] };
    return Array.isArray(data.iceServers) ? data.iceServers : null;
  } catch {
    return null;
  }
}

function base64UrlDecode(s: string): Uint8Array {
  // base64url → base64
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const bin = atob(padded + "=".repeat(padLen));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Pre-upgrade gate: validates role + (for daemons) Ed25519 signature
 * proving ownership of the room's pubkey. Returning a Response here
 * causes `routePartykitRequest` to skip the WebSocket upgrade entirely
 * — the client receives an HTTP error instead of a "connected then
 * immediately closed" surprise.
 *
 * Pre-upgrade rejection is also cheaper: failed auth doesn't consume a
 * DO invocation or count against per-DO request quotas.
 */
async function authenticate(
  request: Request,
  lobby: Lobby<Env>,
): Promise<Response | undefined> {
  // `lobby.name` is the room name extracted by PartyServer's router,
  // which we use as the daemon pubkey.
  const roomPubkey = lobby.name;
  if (!roomPubkey) {
    return new Response("missing_room", { status: 400 });
  }

  const url = new URL(request.url);
  const role = url.searchParams.get("role");
  if (role !== "daemon" && role !== "client") {
    return new Response("bad_role", { status: 400 });
  }

  if (role === "daemon") {
    const ts = Number(url.searchParams.get("ts"));
    const sig = url.searchParams.get("sig");
    if (!Number.isFinite(ts) || !sig) {
      return new Response("missing_signature", { status: 401 });
    }
    if (Math.abs(Date.now() - ts) > MAX_TS_SKEW_MS) {
      return new Response("stale_timestamp", { status: 401 });
    }
    if (!(await verifyDaemonSig(roomPubkey, ts, sig))) {
      return new Response("bad_signature", { status: 401 });
    }
  } else if (!url.searchParams.get("pubkey")) {
    return new Response("missing_client_pubkey", { status: 400 });
  }

  return undefined;
}

/**
 * Worker entry: route incoming requests through PartyServer.
 *
 * PartyKit URL shape: `/parties/signaling/<roomName>` where `signaling`
 * matches the DO binding name (kebab-cased) and `<roomName>` becomes
 * `this.name` inside the DO. We pass the daemon's pubkey as the room.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    // TURN credential mint. The (Ed25519-verified) daemon is the SOLE
    // minter — it relays the creds to its iOS clients over the signaling
    // DataChannel, so clients never hit this endpoint. That keeps minting
    // (which feeds a billable relay) tied to a key whose ownership we can
    // actually prove. Order: rate-limit (cheap) → ts skew → sig verify →
    // mint. Body: { pubkey, ts, sig } with sig over `turn/v1/<pubkey>/<ts>`.
    if (url.pathname === "/turn-credentials") {
      if (request.method !== "POST") {
        return new Response("method_not_allowed", { status: 405 });
      }
      let body: { pubkey?: unknown; ts?: unknown; sig?: unknown };
      try {
        body = await request.json();
      } catch {
        return new Response("bad_json", { status: 400 });
      }
      const pubkey = typeof body.pubkey === "string" ? body.pubkey : "";
      const ts = Number(body.ts);
      const sig = typeof body.sig === "string" ? body.sig : "";
      if (!pubkey || !Number.isFinite(ts) || !sig) {
        return new Response("missing_fields", { status: 400 });
      }
      // Backstop cap before the (more expensive) signature verify, keyed by
      // daemon pubkey so one key can't drain the shared mint budget.
      const rl = await env.RL_TURN.limit({ key: `turn:${pubkey}` });
      if (!rl.success) {
        return new Response("rate_limited", { status: 429 });
      }
      if (Math.abs(Date.now() - ts) > MAX_TS_SKEW_MS) {
        return new Response("stale_timestamp", { status: 401 });
      }
      if (!(await verifyEd25519(pubkey, turnSigMessage(pubkey, ts), sig))) {
        return new Response("bad_signature", { status: 401 });
      }
      // Secrets (set via `wrangler secret put`) aren't in the generated Env
      // type; read them via a localized cast. Unset → 503 so the daemon
      // logs it and falls back to STUN-only rather than hard-failing.
      const { TURN_KEY_ID, TURN_API_TOKEN } = env;
      if (!TURN_KEY_ID || !TURN_API_TOKEN) {
        return new Response("turn_not_configured", { status: 503 });
      }
      const iceServers = await mintTurnCredentials(TURN_KEY_ID, TURN_API_TOKEN);
      if (!iceServers) {
        return new Response("turn_mint_failed", { status: 502 });
      }
      return Response.json({ iceServers });
    }

    // Connect-rate cap applied at the outer fetch boundary so it runs
    // BEFORE any PartyServer routing / DO instantiation. Cheaper than
    // Ed25519 verify, so attackers flooding the endpoint pay only the
    // ratelimit lookup cost.
    //
    // Keyed by room pubkey (URL path segment) so a flood at one daemon
    // doesn't starve unrelated rooms.
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "parties" && parts[2]) {
      const roomPubkey = parts[2];
      const rl = await env.RL_CONNECT.limit({ key: `connect:${roomPubkey}` });
      if (!rl.success) {
        return new Response("rate_limited", { status: 429 });
      }
    }

    return (
      (await routePartykitRequest(request, env, {
        onBeforeConnect: authenticate,
      })) || new Response("not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
