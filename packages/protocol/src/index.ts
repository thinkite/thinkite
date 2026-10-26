import semver from "semver";
import pkg from "../package.json" with { type: "json" };

export {
  decodeWireFrameLength,
  decodeWireFramePayload,
  encodeWireFrame,
  IROH_HTTP_ALPN,
  IROH_RPC_ALPN,
  IROH_TCP_ALPN,
  IROH_TCP_HEADER_BYTES,
  MAX_WIRE_FRAME_BYTES,
  WIRE_FRAME_HEADER_BYTES,
} from "./wire-frame.ts";

// ─── Protocol version ──────────────────────────────────────────────────────
//
// Single source of truth for "what wire schemas does this side speak."
// The protocol package IS the wire contract, so its semver IS the wire
// version — daemon and iOS both import this same value (whatever's in
// `packages/protocol/package.json`'s `version` field).
//
// Bumping = edit `packages/protocol/package.json` (e.g. `npm version
// patch`). No constant elsewhere to keep in sync; the package.json IS
// the source of truth, both at npm-install time and at runtime.
//
// Compatibility check (`isProtocolCompatible`) also lives in this
// package so the rule travels with the frame types it's protecting. The
// frames are plain TypeScript types: nothing here validates at runtime.
// The daemon checks what clients send (daemon/src/client-frame.ts); the
// clients trust the daemon they handshook with.
// Transports just call the helper; they don't reason about semver
// themselves.
//
// Bump policy:
//   - **patch** (0.0.1 → 0.0.2 / 1.2.3 → 1.2.4): additive only — a new
//     optional field, or a whole new frame type that older peers
//     harmlessly ignore (the daemon drops unknown command types, iOS
//     drops unknown event types; extra fields are ignored). NOTE: a new
//     *enum case* on an EXISTING field is NOT automatically additive —
//     it's breaking for a closed set the daemon validates (old daemon
//     rejects the whole frame) or for any consumer that switches on the
//     value without a default. Treat an enum-case add as breaking unless
//     that field is a loose string with a fallback path. Compatible.
//   - **minor** (0.0.x → 0.1.0 during 0.x; 1.0.0 → 1.1.0 post-1.0):
//     0.x minor bump is breaking (npm semver convention for 0.x);
//     ≥1.0 minor bump is additive. The compat helper handles both.
//   - **major** (1.x → 2.0.0): breaking schema change post-1.0.
//   - **pre-release** (`0.5.0-beta.1`): NOT compatible with `0.5.0`
//     per semver convention — pre-releases are explicitly opt-in.
export const PROTOCOL_VERSION: string = pkg.version;

/**
 * True iff a remote peer reporting `remote` speaks a wire-compatible
 * schema set with this build's PROTOCOL_VERSION. Compatible means
 * "same breaking line", per the bump policy above:
 *
 *   - during 0.x the minor is the breaking axis → same `0.minor` line
 *     (`0.5.1` ↔ `0.5.9` compatible in both directions, `0.6.0` not)
 *   - ≥1.0 the major is the breaking axis → same major
 *   - pre-release on either side → exact match only (mid-development
 *     schemas churn; two builds are only known-compatible if identical)
 *
 * Deliberately NOT npm caret semantics. `satisfies(remote, ^local)` is
 * asymmetric — it rejects a remote with a LOWER patch on the same
 * breaking line, but the bump policy says patch bumps are additive and
 * old peers harmlessly ignore them. Symmetric same-line comparison is
 * the faithful implementation, and it guarantees the daemon (which
 * checks `hello` first) always rejects before iOS gets a chance to —
 * iOS's `server_info` re-check is pure drift defense.
 *
 * Returns `false` on unparseable input (defensive — we'd rather refuse
 * than blunder on with an unknown version that might or might not be
 * compatible).
 */
export function isProtocolCompatible(remote: string): boolean {
  const r = semver.parse(remote);
  const local = semver.parse(PROTOCOL_VERSION);
  if (!r || !local) return false;
  if (r.prerelease.length > 0 || local.prerelease.length > 0) {
    return semver.eq(r, local);
  }
  if (r.major !== local.major) return false;
  return local.major === 0 ? r.minor === local.minor : true;
}

/**
 * Which side is outdated, given the version an INCOMPATIBLE remote
 * reported. Only meaningful after `isProtocolCompatible(remote)`
 * returned false — incompatible versions are never equal, so the
 * semver-lower side is the one that needs updating.
 *
 * Returns from the caller's perspective: `"remote"` → the peer is
 * older (iOS calling this → tell the user to update the Mac app),
 * `"local"` → this build is older. Returns `null` when the input is
 * unparseable or equal to ours (a peer that rejected us while
 * reporting our own version is misbehaving, not outdated) — callers
 * fall back to direction-neutral "update both" copy.
 */
export function outdatedSide(remote: string): "local" | "remote" | null {
  if (!semver.valid(remote) || !semver.valid(PROTOCOL_VERSION)) return null;
  if (semver.eq(remote, PROTOCOL_VERSION)) return null;
  return semver.lt(remote, PROTOCOL_VERSION) ? "remote" : "local";
}

// ─── Pair offer ────────────────────────────────────────────────────────────
//
// The QR carries just enough to dial + identity-verify the daemon.
// Connection itself is iroh QUIC: `daemonIdentityPublicKey` IS the
// daemon's iroh EndpointId, so the client dials it directly (relays +
// pkarr discovery resolve it to reachable addresses) and the QUIC
// handshake proves the daemon holds the matching private key.
//
// Two fields:
//   - `daemonIdentityPublicKey` — base64url ed25519 raw pubkey ==
//     iroh EndpointId. The 16-hex daemon fingerprint is
//     `sha256(pubkey).slice(0,16)` — derived, not transmitted.
//   - `serviceName` — `os.hostname()` snapshot for the iOS confirm UI.
//
// The QR carries no expiry. Admission of an unknown pubkey is gated
// daemon-side by "is the desktop app's Pair window open" — that flag, not the
// QR, is the authority on "can a fresh client pair right now." A stale
// screenshot is harmless once the window closes.

export const PAIR_OFFER_VERSION = 2;

export interface PairOfferFrame {
  type: "pair.offer";
  v: number;
  /** base64url ed25519 raw pubkey. */
  daemonIdentityPublicKey: string;
  serviceName: string;
}

/**
 * On-the-wire pair offer with one-character keys. The QR is the only
 * place this frame ever appears, and every character in the QR payload
 * costs us ~1 module in the rendered grid. Compacting to single letters
 * keeps the QR a couple version steps smaller.
 */
export interface PairOfferWire {
  v: number;
  /** daemonIdentityPublicKey */
  k: string;
  /** serviceName */
  s: string;
}

export function toPairOfferWire(offer: PairOfferFrame): PairOfferWire {
  return { v: offer.v, k: offer.daemonIdentityPublicKey, s: offer.serviceName };
}

/** A scanned QR is outside input: checked field by field, throwing on
 *  anything that is not a pair offer. */
export function fromPairOfferWire(wire: unknown): PairOfferFrame {
  const w = wire as Partial<Record<keyof PairOfferWire, unknown>> | null;
  if (
    typeof w !== "object" ||
    w === null ||
    !Number.isInteger(w.v) ||
    typeof w.k !== "string" ||
    typeof w.s !== "string"
  )
    throw new Error("not a pair offer");
  return {
    type: "pair.offer",
    v: w.v as number,
    daemonIdentityPublicKey: w.k,
    serviceName: w.s,
  };
}

/** Encode a pair offer to its QR wire form: base64url of UTF-8 JSON. */
export function encodePairOffer(offer: PairOfferFrame): string {
  const json = JSON.stringify(toPairOfferWire(offer));
  return base64urlEncodeUtf8(json);
}

/** Decode the wire form produced by `encodePairOffer`. */
export function decodePairOfferPayload(payload: string): PairOfferFrame {
  return fromPairOfferWire(JSON.parse(base64urlDecodeUtf8(payload)));
}

function base64urlEncodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecodeUtf8(b64: string): string {
  const padded = b64 + "===".slice(0, (4 - (b64.length % 4)) % 4);
  const std = padded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(std);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ─── Git changes: live subscription (workspace info bar) ──────────────────
//
// Clients read a folder's repository (branch, counts, diff) from opencode's
// `vcs`, which pushes no event for file changes. `subscribeGitStatus` is
// the change signal: a PURE change stream (no initial in its response) of
// `gitStatus` events as the daemon's per-cwd watcher sees the numbers move;
// clients take each as "read again" (the status is the daemon's own count,
// against the upstream or HEAD, not opencode's). Closing the connection
// implicitly unsubscribes; an explicit `unsubscribeGitStatus` releases the
// watcher ref-count early so the daemon can dispose its fs.watch handles.

export interface GitStatus {
  /** False when `cwd` isn't a git repository. Numeric fields are zero,
   *  `branch` is null, `project` is still filled with basename(cwd). */
  isRepo: boolean;
  /** `path.basename(cwd)`. Daemon's heuristic — what the user sees in
   *  Finder, no `package.json` peek, works for any language. */
  project: string;
  /** Null when not a repo OR in detached-HEAD state. */
  branch: string | null;
  ahead: number;
  behind: number;
  insertions: number;
  deletions: number;
  isDirty: boolean;
}

export interface SubscribeGitStatusCommand {
  type: "subscribeGitStatus";
  requestId: string;
  cwd: string;
}

/** Pure change-stream ack — NO initial snapshot.
 *  The watcher's listener fires only on subsequent changes, delivered as
 *  `gitStatus` events. */
export interface SubscribeGitStatusResponse {
  type: "subscribeGitStatus.response";
  requestId: string;
  cwd: string;
}

export interface UnsubscribeGitStatusCommand {
  type: "unsubscribeGitStatus";
  requestId: string;
  cwd: string;
}

export interface UnsubscribeGitStatusResponse {
  type: "unsubscribeGitStatus.response";
  requestId: string;
}

/** Server-initiated push. `cwd` is the routing key — iOS may subscribe
 *  to multiple cwds (e.g. listing pages) and route by this field. */
export interface GitStatusEvent {
  type: "gitStatus";
  cwd: string;
  status: GitStatus;
}

// ─── Filesystem browser (cwd picker + V0.5+ file picker) ───────────────────
//
// One workhorse RPC + one bootstrap RPC. The workhorse `listDirectory`
// reads a single directory level (Finder-style hierarchical browser);
// the bootstrap `getFilesystemRoots` returns the home/desktop/documents
// paths iOS needs as starting points + a recents list aggregated from
// session history (since iOS doesn't know the daemon machine's HOME).
//
// File-picker readiness: `includeFiles` defaults to false for V0's
// folder-only picker; flipping it surfaces files too. `DirectoryEntry`
// carries optional size + modifiedAt so a future file picker can show
// metadata without a schema bump. To skip the per-file stat cost in
// the V0 folder-only path, the daemon's handler ONLY stats entries
// when `includeFiles === true`.

export interface DirectoryEntry {
  /** Last path segment, e.g. "src" or "package.json". */
  name: string;
  /** Absolute path. */
  path: string;
  kind: "directory" | "file";
  /** Size in bytes. Populated only when the response includes files
   *  AND the daemon could stat the entry. Absent otherwise. */
  size?: number;
  /** ISO 8601 mtime. Populated alongside `size` only. */
  modifiedAt?: string;
}

export interface ListDirectoryCommand {
  type: "listDirectory";
  requestId: string;
  /** Absolute path, or "~" / "~/..." (server expands to HOME). Anything
   *  else (relative paths, "~user") is treated as-is and likely errors. */
  path: string;
  /** Include files in the response. Default false — V0 folder picker
   *  needs directories only, skipping files lets the daemon skip the
   *  per-entry stat loop entirely. */
  includeFiles?: boolean;
  /** Include dotfile / dot-directory entries (.git, .config, etc.).
   *  Default false. */
  includeHidden?: boolean;
}

export interface ListDirectoryResponse {
  type: "listDirectory.response";
  requestId: string;
  /** Echoed canonical absolute path of the listed dir (post-"~"-expansion). */
  path: string;
  /** Parent absolute path for breadcrumb / up-nav. Null when at the
   *  filesystem root ("/"). */
  parent: string | null;
  /** Sorted by daemon: directories first, then files; alphabetical
   *  within each group (case-insensitive). iOS can render straight
   *  through without re-sorting. */
  entries: DirectoryEntry[];
}

/** Recent cwd entry — union of Desktop session cwds and sidecode session
 *  cwds, filtered to only paths that still exist on disk (stale cwds
 *  from deleted/moved projects are dropped). */
export interface RecentCwd {
  path: string;
  /** ISO 8601 timestamp of the most recent session activity at this cwd. */
  lastUsedAt: string;
}

export interface GetFilesystemRootsCommand {
  type: "getFilesystemRoots";
  requestId: string;
}

export interface GetFilesystemRootsResponse {
  type: "getFilesystemRoots.response";
  requestId: string;
  /** Daemon machine's HOME directory absolute path (e.g.
   *  "/Users/you"). Always populated — every OS has $HOME. */
  home: string;
  /** `${home}/Desktop` if it exists on disk. Optional because Desktop
   *  is not universal (Linux headless servers / non-standard XDG
   *  locales lack it); macOS always has it. */
  desktop?: string;
  /** `${home}/Documents` if it exists on disk. Same optionality
   *  reasoning as `desktop`. */
  documents?: string;
  /** Recent project cwds, sorted by lastUsedAt desc, deduped and
   *  filtered to existing paths. Max 10. */
  recentCwds: RecentCwd[];
}

// ─── Previews: servers the agent started ──────────────────────────────────
//
// The agent starts dev servers and APIs with the daemon's `server_start`
// (docs/preview-tool-v1.md); to show the user a page it writes the link in
// its reply, and the client the user reads it in opens it by its port. Per
// project directory, same shape as git status: `getPreviews` is the
// snapshot, `subscribePreviews` a pure change stream of full `previews`
// snapshots. Separately, `forwardPorts` lists every running server's ports
// across projects: what the phone forwards while it is in the foreground.

export interface PreviewEntry {
  /** The agent's label, unique per directory ("web", "api"). */
  name: string;
  /** The TCP ports its processes listen on, ascending, as last seen: kept
   *  after it ends. Absent until it listens. A link in a reply to
   *  `localhost` on one of these ports is this server's page. */
  ports?: number[];
  /** `http://localhost:<lowest port>/`, with `ports`: the page the Servers
   *  list opens. */
  url?: string;
  status: "running" | "ended";
  /** The shell's command. */
  command: string;
  /** When its shell started, and the session whose agent started it. */
  started: { at: number; sessionID?: string };
  /** How it ended: the user's stop button, an agent's `server_stop` (and
   *  which session), the process exiting, opencode unloading the project
   *  (after an hour without activity, or a reload: its shells end with it),
   *  or something else outside Thinkite (opencode's kill, a service
   *  restart). */
  ended?: {
    at: number;
    by: "user" | "agent" | "process" | "unloaded" | "external";
    sessionID?: string;
    exit?: number;
  };
}

export interface GetPreviewsCommand {
  type: "getPreviews";
  requestId: string;
  directory: string;
}

export interface GetPreviewsResponse {
  type: "getPreviews.response";
  requestId: string;
  directory: string;
  entries: PreviewEntry[];
}

/** Pure change-stream ack — NO initial snapshot (use `getPreviews`). */
export interface SubscribePreviewsCommand {
  type: "subscribePreviews";
  requestId: string;
  directory: string;
}

export interface SubscribePreviewsResponse {
  type: "subscribePreviews.response";
  requestId: string;
  directory: string;
}

export interface UnsubscribePreviewsCommand {
  type: "unsubscribePreviews";
  requestId: string;
  directory: string;
}

export interface UnsubscribePreviewsResponse {
  type: "unsubscribePreviews.response";
  requestId: string;
}

/** The user's stop button: the agent's `server_stop`, recorded as the
 *  user's. */
export interface StopPreviewCommand {
  type: "stopPreview";
  requestId: string;
  directory: string;
  name: string;
}

export interface StopPreviewResponse {
  type: "stopPreview.response";
  requestId: string;
}

/** Server-initiated push: the directory's full snapshot after any change. */
export interface PreviewsEvent {
  type: "previews";
  directory: string;
  entries: PreviewEntry[];
}

/** A port a running server listens on, in any project. */
export interface ForwardPort {
  port: number;
  directory: string;
  name: string;
}

export interface GetForwardPortsCommand {
  type: "getForwardPorts";
  requestId: string;
}

export interface GetForwardPortsResponse {
  type: "getForwardPorts.response";
  requestId: string;
  ports: ForwardPort[];
}

/** Pure change-stream ack — NO initial snapshot (use `getForwardPorts`). */
export interface SubscribeForwardPortsCommand {
  type: "subscribeForwardPorts";
  requestId: string;
}

export interface SubscribeForwardPortsResponse {
  type: "subscribeForwardPorts.response";
  requestId: string;
}

export interface UnsubscribeForwardPortsCommand {
  type: "unsubscribeForwardPorts";
  requestId: string;
}

export interface UnsubscribeForwardPortsResponse {
  type: "unsubscribeForwardPorts.response";
  requestId: string;
}

/** Server-initiated push: the full list whenever it changes. */
export interface ForwardPortsEvent {
  type: "forwardPorts";
  ports: ForwardPort[];
}

// ─── Health + error ────────────────────────────────────────────────────────

export interface PingFrame {
  type: "ping";
  t: number;
}

export interface PongFrame {
  type: "pong";
  t: number;
  echoT: number;
}

export type ErrorCode =
  | "invalid_message"
  | "unauthenticated"
  | "session_not_found"
  | "internal"
  | "unsupported"
  | "rate_limited"
  | "incompatible_protocol"
  // Filesystem browser errors (listDirectory / getFilesystemRoots).
  | "not_found"
  | "permission_denied"
  | "not_a_directory";

export interface ErrorFrame {
  type: "error";
  requestId?: string;
  code: ErrorCode;
  message: string;
  /** Sender's PROTOCOL_VERSION. Set on `incompatible_protocol` VERSION-
   *  mismatch rejections so the receiver can run `outdatedSide()` and
   *  name the side that needs updating. Deliberately absent on the
   *  other `incompatible_protocol` use (frame-before-hello, a protocol-
   *  misuse rejection where versions may well be EQUAL and direction is
   *  meaningless) and on all other codes. */
  protocolVersion?: string;
}

// ─── Hello / server_info (wire-version handshake on stream open) ──────────
//
// iOS sends `hello` as the first frame on the RPC stream carrying its
// PROTOCOL_VERSION. Daemon checks compatibility via `isProtocolCompatible`
// and responds with its own `server_info` (or with
// `error{code:"incompatible_protocol", protocolVersion}` + close on
// mismatch — the version lets iOS name which side is outdated via
// `outdatedSide`). iOS treats `server_info` as the "ready" signal —
// application commands may only flow after it arrives.
//
// Single field exchanged each way. There's no separate "app release
// version" / "daemon release version" — the protocol package owns the
// only version that matters for whether the two ends can talk.

export interface HelloCommand {
  type: "hello";
  protocolVersion: string;
}

export interface ServerInfoEvent {
  type: "server_info";
  protocolVersion: string;
}

// ─── Top-level direction unions ────────────────────────────────────────────
//
// The RPC carries what opencode does not offer the phone: git status and
// diffs, the folder picker, the agent's servers and pages, and the ports to
// forward. Sessions, prompts and transcripts go to opencode over the HTTP
// tunnel (IROH_HTTP_ALPN) instead.

export type Command =
  | SubscribeGitStatusCommand
  | UnsubscribeGitStatusCommand
  | ListDirectoryCommand
  | GetFilesystemRootsCommand
  | GetPreviewsCommand
  | SubscribePreviewsCommand
  | UnsubscribePreviewsCommand
  | StopPreviewCommand
  | GetForwardPortsCommand
  | SubscribeForwardPortsCommand
  | UnsubscribeForwardPortsCommand;

export type Response =
  | SubscribeGitStatusResponse
  | UnsubscribeGitStatusResponse
  | ListDirectoryResponse
  | GetFilesystemRootsResponse
  | GetPreviewsResponse
  | SubscribePreviewsResponse
  | UnsubscribePreviewsResponse
  | StopPreviewResponse
  | GetForwardPortsResponse
  | SubscribeForwardPortsResponse
  | UnsubscribeForwardPortsResponse;

/** All frames a client may send to the daemon over the authenticated iroh
 *  stream. `hello` is the only frame the daemon accepts before the
 *  wire-version handshake completes (see HelloCommand). */
export type ClientFrame = HelloCommand | PingFrame | Command;

/** All frames the daemon may send to a client. `server_info` is the
 *  daemon's reply to `hello` and the signal that the client may begin
 *  sending commands. */
export type DaemonFrame =
  | ServerInfoEvent
  | PongFrame
  | ErrorFrame
  | GitStatusEvent
  | PreviewsEvent
  | ForwardPortsEvent
  | Response;
